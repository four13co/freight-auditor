import type pg from 'pg';

/** JSON-safe axis values keep resolver keys serializable and replayable. */
export type ExternalAxisValue = string | number | boolean | null;
export type ExternalAxisKey = Readonly<Record<string, ExternalAxisValue>>;

export interface ExternalValueRequest {
  sourceCode: string;
  axisKey: ExternalAxisKey;
  /** Business date the publication must apply to, not the current date. */
  publishedFor: string;
  /** Optional bitemporal cutoff used when replaying what was known at audit time. */
  recordedAsOf?: string;
}

export interface ExternalValuePin {
  externalValueId: string;
  sourceId: string;
  sourceCode: string;
  axisKey: ExternalAxisKey;
  publishedFor: string;
  recordedAt: string;
}

export type ExternalValueResolution =
  | { status: 'FOUND'; value: string; pin: ExternalValuePin; resolverVersion: string }
  | {
      status: 'UNAVAILABLE';
      reason: 'SOURCE_NOT_CONFIGURED' | 'VALUE_NOT_PUBLISHED' | 'LICENSE_REQUIRED' | 'INVALID_REQUEST';
      resolverVersion: string;
    };

export interface ExternalValueResolver {
  readonly sourceCode: string;
  readonly resolverVersion: string;
  resolve(client: pg.PoolClient, request: ExternalValueRequest): Promise<ExternalValueResolution>;
}

export class DuplicateExternalResolverError extends Error {}

/** Stable source-code routing boundary shared by EIA, mileage, NMFC, and ocean adapters. */
export class ExternalResolverRegistry {
  readonly #resolvers = new Map<string, ExternalValueResolver>();

  constructor(resolvers: readonly ExternalValueResolver[]) {
    for (const resolver of resolvers) {
      const sourceCode = normalizeSourceCode(resolver.sourceCode);
      if (this.#resolvers.has(sourceCode)) {
        throw new DuplicateExternalResolverError(`duplicate external resolver for ${sourceCode}`);
      }
      this.#resolvers.set(sourceCode, resolver);
    }
  }

  async resolve(client: pg.PoolClient, request: ExternalValueRequest): Promise<ExternalValueResolution> {
    const sourceCode = normalizeSourceCode(request.sourceCode);
    const resolver = this.#resolvers.get(sourceCode);
    if (!resolver) {
      return { status: 'UNAVAILABLE', reason: 'SOURCE_NOT_CONFIGURED', resolverVersion: 'registry-v1' };
    }
    if (!isIsoDate(request.publishedFor) || (request.recordedAsOf !== undefined && !isIsoTimestamp(request.recordedAsOf))) {
      return { status: 'UNAVAILABLE', reason: 'INVALID_REQUEST', resolverVersion: resolver.resolverVersion };
    }
    return resolver.resolve(client, {
      ...request,
      sourceCode,
      axisKey: canonicalAxisKey(request.axisKey),
    });
  }
}

export function canonicalAxisKey(axisKey: ExternalAxisKey): ExternalAxisKey {
  return Object.fromEntries(Object.entries(axisKey).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeSourceCode(sourceCode: string): string {
  return sourceCode.trim().toUpperCase();
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
