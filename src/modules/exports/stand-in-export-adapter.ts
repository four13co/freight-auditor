import type pg from 'pg';
import type { ExportAdapter, ExportRecord, ExportResult } from './export-adapter.js';

/**
 * Deterministic no-network stand-in for a real AP/ERP export adapter. No target vendor has been
 * chosen yet (P4.B.8); this exists so the registry contract and idempotency behavior are testable
 * without inventing a vendor format. Set `payload.simulateFailure` to exercise the FAILED branch.
 */
export class StandInExportAdapter implements ExportAdapter {
  readonly systemCode: string;
  readonly adapterVersion = 'stand-in-v1';
  readonly #seen = new Map<string, ExportResult>();
  #effectCount = 0;

  constructor(systemCode: string) {
    this.systemCode = systemCode;
  }

  /** Number of distinct external effects produced — the idempotency contract keeps this at one per dedupeKey. */
  get effectCount(): number {
    return this.#effectCount;
  }

  async export(_client: pg.PoolClient, record: ExportRecord): Promise<ExportResult> {
    const existing = this.#seen.get(record.dedupeKey);
    if (existing) {
      return existing;
    }

    this.#effectCount += 1;
    const result: ExportResult = record.payload.simulateFailure === true
      ? { status: 'FAILED', reason: 'SIMULATED_FAILURE', adapterVersion: this.adapterVersion }
      : {
          status: 'ACKNOWLEDGED',
          externalReference: `standin-${record.systemCode}-${record.dedupeKey}`,
          adapterVersion: this.adapterVersion,
        };

    this.#seen.set(record.dedupeKey, result);
    return result;
  }
}
