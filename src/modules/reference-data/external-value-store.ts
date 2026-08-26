import { Decimal } from 'decimal.js';
import type pg from 'pg';
import { canonicalAxisKey, type ExternalAxisKey, type ExternalValuePin } from './external-value-resolver.js';

export interface ExternalPublicationInput {
  sourceId: string;
  publicationVersion: string;
  publishedAt: string;
  contentHash?: string;
  sourceDocumentId?: string;
}

export async function persistExternalPublication(
  client: pg.PoolClient,
  input: ExternalPublicationInput,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO external_publication
       (source_id, publication_version, published_at, content_hash, source_document_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (source_id, publication_version) DO NOTHING
     RETURNING id`,
    [input.sourceId, input.publicationVersion, input.publishedAt, input.contentHash ?? null, input.sourceDocumentId ?? null],
  );
  if (result.rows[0]) return result.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM external_publication WHERE source_id = $1 AND publication_version = $2`,
    [input.sourceId, input.publicationVersion],
  );
  if (!existing.rows[0]) throw new Error('external publication idempotency lookup failed');
  return existing.rows[0].id;
}

export async function persistExternalValue(client: pg.PoolClient, input: {
  sourceId: string;
  publicationId: string;
  axisKey: ExternalAxisKey;
  publishedFor: string;
  value: string;
}): Promise<{ id: string; value: string }> {
  const value = new Decimal(input.value).toFixed(6);
  const axisKey = canonicalAxisKey(input.axisKey);
  const inserted = await client.query<{ id: string; value: string }>(
    `INSERT INTO external_value (source_id, publication_id, axis_key, published_for, value)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (publication_id, axis_key, published_for) WHERE publication_id IS NOT NULL DO NOTHING
     RETURNING id, value`,
    [input.sourceId, input.publicationId, JSON.stringify(axisKey), input.publishedFor, value],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, value: new Decimal(inserted.rows[0].value).toFixed(6) };
  const existing = await client.query<{ id: string; value: string }>(
    `SELECT id, value FROM external_value
     WHERE publication_id = $1 AND axis_key = $2::jsonb AND published_for = $3`,
    [input.publicationId, JSON.stringify(axisKey), input.publishedFor],
  );
  if (!existing.rows[0]) throw new Error('external value idempotency lookup failed');
  if (!new Decimal(existing.rows[0].value).equals(value)) {
    throw new Error('external publication value conflict');
  }
  return { id: existing.rows[0].id, value: new Decimal(existing.rows[0].value).toFixed(6) };
}

export async function pinExternalValueForAudit(client: pg.PoolClient, input: {
  clientId: string;
  auditRunId: string;
  resolverVersion: string;
  pin: ExternalValuePin;
  value: string;
  publicationId?: string;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO audit_external_value_pin
       (client_id, audit_run_id, external_value_id, publication_id, resolver_version, axis_key, published_for, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (audit_run_id, external_value_id) DO NOTHING
     RETURNING id`,
    [input.clientId, input.auditRunId, input.pin.externalValueId, input.publicationId ?? null,
      input.resolverVersion, JSON.stringify(canonicalAxisKey(input.pin.axisKey)), input.pin.publishedFor,
      new Decimal(input.value).toFixed(6)],
  );
  if (result.rows[0]) return result.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM audit_external_value_pin WHERE audit_run_id = $1 AND external_value_id = $2`,
    [input.auditRunId, input.pin.externalValueId],
  );
  if (!existing.rows[0]) throw new Error('audit external-value pin idempotency lookup failed');
  return existing.rows[0].id;
}
