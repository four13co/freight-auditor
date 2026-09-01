import type pg from 'pg';
import { z } from 'zod';
import type { PortfolioReconciliationBucket } from './reconcile-portfolio-totals.js';

export interface ReconciliationExportRow {
  id: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  result: PortfolioReconciliationBucket[] | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

const requestSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(255),
}).strict();

export interface RequestReconciliationExportResult {
  exportId: string;
  created: boolean;
}

/**
 * Records an analyst's request for a reconciliation export (P5.C.5).
 * Deliberately does NOT compute anything or enqueue a job here -- this is
 * the "persist the intent" half of the boundary (see 0067's migration
 * comment); SCAN_RECONCILIATION_EXPORTS_V1 (worker-side) is what claims this
 * row and dispatches the job that actually runs getPortfolioReconciliation.
 *
 * Idempotent on (clientId, idempotencyKey): a retry after a crash between
 * this insert and the caller receiving its response returns the existing
 * row instead of creating a second export.
 */
export async function requestReconciliationExport(
  client: pg.PoolClient,
  untrusted: z.input<typeof requestSchema>,
): Promise<RequestReconciliationExportResult> {
  const input = requestSchema.parse(untrusted);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO reconciliation_export (client_id, idempotency_key)
     VALUES ($1, $2)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.clientId, input.idempotencyKey],
  );
  if (inserted.rowCount) {
    return { exportId: inserted.rows[0]!.id, created: true };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM reconciliation_export WHERE client_id = $1 AND idempotency_key = $2`,
    [input.clientId, input.idempotencyKey],
  );
  return { exportId: existing.rows[0]!.id, created: false };
}

const getSchema = z.object({
  clientId: z.uuid(),
  exportId: z.uuid(),
}).strict();

/** Tenant-scoped read for status polling. Returns null when not found (or not this tenant's, structurally enforced by RLS). */
export async function getReconciliationExport(
  client: pg.PoolClient,
  untrusted: z.input<typeof getSchema>,
): Promise<ReconciliationExportRow | null> {
  const input = getSchema.parse(untrusted);

  const { rows } = await client.query<{
    id: string;
    status: 'pending' | 'claimed' | 'completed' | 'failed';
    result: PortfolioReconciliationBucket[] | null;
    error: string | null;
    requested_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, status, result, error, requested_at, completed_at
       FROM reconciliation_export
      WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.exportId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    result: row.result,
    error: row.error,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

const claimDueSchema = z.object({
  clientId: z.uuid(),
  now: z.date(),
  limit: z.number().int().positive().default(50),
}).strict();

export interface ClaimedReconciliationExport {
  exportId: string;
  idempotencyKey: string;
}

/**
 * Atomically claims pending reconciliation_export rows by flipping them to
 * 'claimed' and returning the rows in one statement -- the UPDATE...RETURNING
 * is the compare-and-set, mirroring claimDueOutboxMessages, so two concurrent
 * scan ticks can never both claim the same export. FOR UPDATE SKIP LOCKED
 * lets concurrent claims proceed over disjoint rows. Ordered by requested_at
 * so the oldest request is served first.
 */
export async function claimDueReconciliationExports(
  client: pg.PoolClient,
  untrusted: z.input<typeof claimDueSchema>,
): Promise<ClaimedReconciliationExport[]> {
  const input = claimDueSchema.parse(untrusted);

  const result = await client.query<{ id: string; idempotency_key: string }>(
    `UPDATE reconciliation_export
     SET status = 'claimed'
     WHERE id IN (
       SELECT id FROM reconciliation_export
       WHERE client_id = $1 AND status = 'pending' AND requested_at <= $2
       ORDER BY requested_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, idempotency_key`,
    [input.clientId, input.now.toISOString(), input.limit],
  );

  return result.rows.map((row) => ({ exportId: row.id, idempotencyKey: row.idempotency_key }));
}

const completeSchema = z.object({
  clientId: z.uuid(),
  exportId: z.uuid(),
  result: z.array(z.unknown()),
}).strict();

export interface CompleteReconciliationExportResult {
  found: boolean;
}

/** Marks a claimed export completed with its computed result. Same-state (already 'completed') is a no-op success -- an idempotent retry after a crash between claim and completion. */
export async function completeReconciliationExport(
  client: pg.PoolClient,
  untrusted: z.input<typeof completeSchema>,
): Promise<CompleteReconciliationExportResult> {
  const input = completeSchema.parse(untrusted);

  const result = await client.query(
    `UPDATE reconciliation_export
     SET status = 'completed', result = $3::jsonb, completed_at = now()
     WHERE client_id = $1 AND id = $2 AND status IN ('claimed', 'completed')`,
    [input.clientId, input.exportId, JSON.stringify(input.result)],
  );
  return { found: result.rowCount !== null && result.rowCount > 0 };
}

const failSchema = z.object({
  clientId: z.uuid(),
  exportId: z.uuid(),
  error: z.string().trim().min(1).max(2000),
}).strict();

export interface FailReconciliationExportResult {
  found: boolean;
}

/** Marks a claimed export failed with a caller-safe error message (never the raw thrown error/stack). Same-state (already 'failed') is a no-op success. */
export async function failReconciliationExport(
  client: pg.PoolClient,
  untrusted: z.input<typeof failSchema>,
): Promise<FailReconciliationExportResult> {
  const input = failSchema.parse(untrusted);

  const result = await client.query(
    `UPDATE reconciliation_export
     SET status = 'failed', error = $3, completed_at = now()
     WHERE client_id = $1 AND id = $2 AND status IN ('claimed', 'failed')`,
    [input.clientId, input.exportId, input.error],
  );
  return { found: result.rowCount !== null && result.rowCount > 0 };
}
