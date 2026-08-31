import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { isClaimTerminalStatus } from './claim-status.js';

/**
 * The audit_event name P5.B.2's generateClaimFollowUp writes. Duplicated
 * here as a string literal rather than imported from
 * generate-claim-follow-up.ts (P5.B.2/#184, still open/unmerged) -- same
 * treatment CLAIM_TERMINAL_EVENTS (P5.A.5) gave resolve-claim.ts's event
 * names. Once #184 merges, this should import the constant instead.
 */
export const CLAIM_FOLLOW_UP_EVENT = 'claim.follow_up_sent';

const DEFAULT_GRACE_PERIOD_DAYS = 7;

export type GenerateClaimEscalationErrorCode =
  | 'CLAIM_NOT_FOUND' | 'CLAIM_TERMINAL' | 'NO_FOLLOW_UP_SENT' | 'GRACE_PERIOD_NOT_ELAPSED';

export class GenerateClaimEscalationError extends Error {
  constructor(readonly code: GenerateClaimEscalationErrorCode) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GenerateClaimEscalationError';
  }
}

export interface GenerateClaimEscalationResult {
  claimId: string;
  auditEventId: string;
  created: boolean;
}

interface ClaimRow {
  id: string;
  client_id: string;
  status: string;
}

interface FollowUpEventRow {
  recorded_at: Date;
}

/**
 * Records a claim.escalated audit event for a claim that already has a
 * follow-up marker and remains open past a grace period since that
 * follow-up (P5.B.3, 86e2zfja3). Second-stage, not a deadline replacement:
 * this does NOT re-check claim.aging_deadline_at directly -- it trusts that
 * a claim.follow_up_sent event could only exist because P5.B.2's own gate
 * already passed once.
 *
 * Idempotent via writeAuditEvent's deterministic-id + ON CONFLICT DO
 * NOTHING, same pattern as generateClaimFollowUp.
 */
export async function generateClaimEscalation(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
  now: Date = new Date(),
  gracePeriodDays: number = DEFAULT_GRACE_PERIOD_DAYS,
): Promise<GenerateClaimEscalationResult> {
  const claimResult = await client.query<ClaimRow>(
    `SELECT id, client_id, status FROM claim WHERE client_id = $1 AND id = $2`,
    [clientId, claimId],
  );
  const claim = claimResult.rows[0];
  if (!claim) throw new GenerateClaimEscalationError('CLAIM_NOT_FOUND');
  if (isClaimTerminalStatus(claim.status)) throw new GenerateClaimEscalationError('CLAIM_TERMINAL');

  const followUpResult = await client.query<FollowUpEventRow>(
    `SELECT recorded_at FROM audit_event
     WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = $3
     ORDER BY recorded_at DESC LIMIT 1`,
    [clientId, claimId, CLAIM_FOLLOW_UP_EVENT],
  );
  const followUp = followUpResult.rows[0];
  if (!followUp) throw new GenerateClaimEscalationError('NO_FOLLOW_UP_SENT');

  const graceDeadline = new Date(followUp.recorded_at);
  graceDeadline.setUTCDate(graceDeadline.getUTCDate() + gracePeriodDays);
  if (graceDeadline.getTime() > now.getTime()) throw new GenerateClaimEscalationError('GRACE_PERIOD_NOT_ELAPSED');

  const auditEventId = deterministicAuditEventId(claim.client_id, claim.id, 'claim.escalated');
  const { created } = await writeAuditEvent(client, {
    id: auditEventId,
    clientId: claim.client_id,
    entity: 'claim',
    entityId: claim.id,
    event: 'claim.escalated',
    actorKind: 'system',
    detail: { followUpRecordedAt: followUp.recorded_at.toISOString(), gracePeriodDays },
  });

  return { claimId: claim.id, auditEventId, created };
}
