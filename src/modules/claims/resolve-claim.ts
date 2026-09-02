import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { validateClaimResolution, type ClaimRow, type ClaimResolutionKind } from './validate-claim-resolution.js';
import { updateFindingStatus } from '../findings/update-finding-status.js';

const schema = z.object({
  clientId: z.uuid(),
  claimId: z.uuid(),
  kind: z.enum(['FULL_RECOVERY', 'DENIAL', 'WRITE_OFF']),
  amountRecovered: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().default(null),
  currency: z.string().length(3).nullable().default(null),
  varianceFindingId: z.uuid().optional(),
}).strict();

export { ClaimResolutionError } from './validate-claim-resolution.js';

export class ResolveClaimError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ResolveClaimError';
  }
}

export interface ResolveClaimResult {
  claimId: string;
  kind: ClaimResolutionKind;
  newStatus: 'recovered' | 'denied' | 'written_off';
  recoveryEventId: string | null;
}

/**
 * Resolve a claim to one of its three terminal outcomes (P5.A.4):
 * FULL_RECOVERY, DENIAL, or WRITE_OFF -- see validate-claim-resolution.ts
 * for the rules governing each. Writes the terminal recovery_event (when
 * the resolution carries a recovered amount -- FULL_RECOVERY always does,
 * WRITE_OFF sometimes does, DENIAL never does) and updates claim.status in
 * the same transaction.
 *
 * This item writes claim.status; it does NOT build a derivation function
 * from append-only events -- that's P5.A.5's boundary ("derive claim
 * status from append-only events"). The status set here is authoritative
 * for this call, not read back from history.
 *
 * claim is NOT on 0010's append-only list (unlike recovery_event), so
 * UPDATE status is a plain granted column write under freight_app.
 */
export async function resolveClaim(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ResolveClaimResult> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{ id: string; amount_claimed: string; currency: string | null; status: string }>(
    `SELECT id, amount_claimed, currency, status FROM claim WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new ResolveClaimError('CLAIM_NOT_FOUND');
  const claim: ClaimRow = { id: claimRow.id, amountClaimed: claimRow.amount_claimed, currency: claimRow.currency, status: claimRow.status };

  const { rows: priorRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_recovered), 0)::text AS total FROM recovery_event WHERE client_id = $1 AND claim_id = $2`,
    [input.clientId, input.claimId],
  );
  const priorTotal = priorRows[0]!.total;

  const validated = validateClaimResolution(claim, input.kind, priorTotal, input.amountRecovered, input.currency);

  let recoveryEventId: string | null = null;
  if (validated.amountRecovered !== null) {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO recovery_event (client_id, claim_id, variance_finding_id, amount_recovered, currency)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.clientId, input.claimId, input.varianceFindingId ?? null, validated.amountRecovered, validated.currency],
    );
    recoveryEventId = inserted[0]!.id;
  }

  await client.query(`UPDATE claim SET status = $3 WHERE client_id = $1 AND id = $2`, [input.clientId, input.claimId, validated.newStatus]);

  // claim has no FK to variance_finding (the link is the caller-supplied
  // varianceFindingId, same as recovery_event's own soft link above) --
  // recovered/written_off are the only two terminal claim outcomes that are
  // also valid variance_status values, so mirror the finding's status only
  // for those, and only when a finding was actually named. Deriving this
  // from a claim's full dispute_line fan-out is P5.A.5's boundary, not this
  // one (see the module doc comment above).
  if (input.varianceFindingId && (validated.newStatus === 'recovered' || validated.newStatus === 'written_off')) {
    await updateFindingStatus(client, input.varianceFindingId, validated.newStatus, `Claim resolved: ${validated.kind}`);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.claimId, `claim.${validated.newStatus}`),
    clientId: input.clientId,
    entity: 'claim',
    entityId: input.claimId,
    event: `claim.${validated.newStatus}`,
    actorKind: 'analyst',
    detail: { kind: validated.kind, amountRecovered: validated.amountRecovered, currency: validated.currency, recoveryEventId },
  });

  return { claimId: input.claimId, kind: validated.kind, newStatus: validated.newStatus, recoveryEventId };
}
