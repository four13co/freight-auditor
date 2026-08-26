import { Decimal } from 'decimal.js';
import type pg from 'pg';
import { canonicalAxisKey, type ExternalValueRequest, type ExternalValueResolution, type ExternalValueResolver } from './external-value-resolver.js';

export const MILEAGE_SOURCE = 'PC_MILER';
export const MILEAGE_RESOLVER_VERSION = 'pc-miler-db-v1';

/** Resolve licensed mileage snapshots by normalized origin/destination and routing profile. */
export class MileageResolver implements ExternalValueResolver {
  readonly sourceCode = MILEAGE_SOURCE;
  readonly resolverVersion = MILEAGE_RESOLVER_VERSION;

  async resolve(client: pg.PoolClient, request: ExternalValueRequest): Promise<ExternalValueResolution> {
    const origin = request.axisKey.origin;
    const destination = request.axisKey.destination;
    if (request.sourceCode !== this.sourceCode || typeof origin !== 'string' || !origin.trim()
      || typeof destination !== 'string' || !destination.trim()) {
      return { status: 'UNAVAILABLE', reason: 'INVALID_REQUEST', resolverVersion: this.resolverVersion };
    }
    const axisKey = canonicalAxisKey({
      ...request.axisKey,
      origin: origin.trim().toUpperCase(),
      destination: destination.trim().toUpperCase(),
    });
    const params: unknown[] = [this.sourceCode, JSON.stringify(axisKey), request.publishedFor];
    const cutoff = request.recordedAsOf ? `AND ev.recorded_at <= $${params.push(request.recordedAsOf)}` : '';
    const result = await client.query<{
      id: string; source_id: string; value: string; published_for: string; recorded_at: Date | string;
    }>(
      `SELECT ev.id, ev.source_id, ev.value, ev.published_for, ev.recorded_at
       FROM external_value ev JOIN external_source es ON es.id = ev.source_id
       LEFT JOIN external_publication ep ON ep.id = ev.publication_id
       WHERE es.code = $1 AND ev.axis_key @> $2::jsonb AND ev.published_for = $3 ${cutoff}
       ORDER BY COALESCE(ep.published_at, ev.recorded_at) DESC, ev.recorded_at DESC, ev.id DESC LIMIT 1`,
      params,
    );
    const row = result.rows[0];
    if (!row) return { status: 'UNAVAILABLE', reason: 'VALUE_NOT_PUBLISHED', resolverVersion: this.resolverVersion };
    return {
      status: 'FOUND', value: new Decimal(row.value).toFixed(6), resolverVersion: this.resolverVersion,
      pin: {
        externalValueId: row.id, sourceId: row.source_id, sourceCode: this.sourceCode, axisKey,
        publishedFor: row.published_for,
        recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
      },
    };
  }
}
