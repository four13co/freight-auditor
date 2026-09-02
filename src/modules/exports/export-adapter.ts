import type pg from 'pg';

export interface ExportRecord {
  systemCode: string;
  /** Repeat submissions with the same dedupeKey must not produce a second external effect. */
  dedupeKey: string;
  payload: Readonly<Record<string, unknown>>;
}

export type ExportResult =
  | { status: 'ACKNOWLEDGED'; externalReference: string; adapterVersion: string }
  | { status: 'FAILED'; reason: string; adapterVersion: string }
  | { status: 'NOT_CONFIGURED'; systemCode: string };

export interface ExportAdapter {
  readonly systemCode: string;
  readonly adapterVersion: string;
  export(client: pg.PoolClient, record: ExportRecord): Promise<ExportResult>;
}

export class DuplicateExportAdapterError extends Error {}

/** Stable system-code routing boundary for AP/ERP export adapters, mirroring ExternalResolverRegistry. */
export class ExportAdapterRegistry {
  readonly #adapters = new Map<string, ExportAdapter>();

  constructor(adapters: readonly ExportAdapter[]) {
    for (const adapter of adapters) {
      const systemCode = normalizeSystemCode(adapter.systemCode);
      if (this.#adapters.has(systemCode)) {
        throw new DuplicateExportAdapterError(`duplicate export adapter for ${systemCode}`);
      }
      this.#adapters.set(systemCode, adapter);
    }
  }

  async export(client: pg.PoolClient, record: ExportRecord): Promise<ExportResult> {
    const systemCode = normalizeSystemCode(record.systemCode);
    const adapter = this.#adapters.get(systemCode);
    if (!adapter) {
      return { status: 'NOT_CONFIGURED', systemCode };
    }
    return adapter.export(client, { ...record, systemCode });
  }
}

function normalizeSystemCode(systemCode: string): string {
  return systemCode.trim().toUpperCase();
}
