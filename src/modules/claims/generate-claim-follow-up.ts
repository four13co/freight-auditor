import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const TERMINAL_STATUSES = new Set(['recovered', 'denied', 'written_off']);

export type GenerateClaimFollowUpErrorCode =
  | 'CLAIM_NOT_FOUND' | 'CLAIM_TERMINAL' | 'NO_DEADLINE_SET' | 'DEADLINE_NOT_PASSED';

export class GenerateClaimFollowUpError extends Error {
  constructor(readonly code: GenerateClaimFollowUpErrorCode) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateClaimFollowUpError';
  }
}

export interface GenerateClaimFollowUpResult {
  claimId: string;
  auditEventId: string;
  created: boolean;
}

interface ClaimRow {
  id: string;
  client_id: string;
  status: string;
  aging_deadline_at: Date | null;
}

/**
 * Records a claim.follow_up_sent audit event for a claim past its aging
 * deadline (P5.B.2, 86e2zfj99). Idempotent via writeAuditEvent's
 * deterministic-id + ON CONFLICT DO NOTHING: an at-least-once queue
 * redelivering the same job for the same claim returns { created: false }
 * instead of duplicating the marker -- no separate SELECT-for-existence
 * check needed.
 *
 * Depends on claim.aging_deadline_at (P5.B.1 / #178, migration 0050) --
 * not appliable until that PR merges, matching #169's declared dependency
 * on workflow_instance (#160).
 */
export async function generateClaimFollowUp(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
  now: Date = new Date(),
): Promise<GenerateClaimFollowUpResult> {
  const result = await client.query<ClaimRow>(
    `SELECT id, client_id, status, aging_deadline_at FROM claim WHERE client_id = $1 AND id = $2`,
    [clientId, claimId],
  );
  const claim = result.rows[0];
  if (!claim) throw new GenerateClaimFollowUpError('CLAIM_NOT_FOUND');
  if (TERMINAL_STATUSES.has(claim.status)) throw new GenerateClaimFollowUpError('CLAIM_TERMINAL');
  if (!claim.aging_deadline_at) throw new GenerateClaimFollowUpError('NO_DEADLINE_SET');
  if (claim.aging_deadline_at.getTime() > now.getTime()) throw new GenerateClaimFollowUpError('DEADLINE_NOT_PASSED');

  const auditEventId = deterministicAuditEventId(claim.client_id, claim.id, 'claim.follow_up_sent');
  const { created } = await writeAuditEvent(client, {
    id: auditEventId,
    clientId: claim.client_id,
    entity: 'claim',
    entityId: claim.id,
    event: 'claim.follow_up_sent',
    actorKind: 'system',
    detail: { agingDeadlineAt: claim.aging_deadline_at.toISOString() },
  });

  return { claimId: claim.id, auditEventId, created };
}
