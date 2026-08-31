import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { updateFindingStatus } from '../findings/update-finding-status.js';
import {
  validateDisputableFindings,
  type DisputableFindingRow,
} from './validate-disputable-findings.js';

const schema = z.object({
  clientId: z.uuid(),
  findingIds: z.array(z.uuid()).min(1).max(500),
  actorUserId: z.uuid().optional(),
});

export { DisputableFindingsError } from './validate-disputable-findings.js';

interface FindingRow {
  id: string;
  status: string;
  carrier_id: string | null;
  currency: string | null;
  variance_amount: string | null;
  direction: DisputableFindingRow['direction'];
}

export interface CreateDisputeResult {
  disputeId: string;
  findingIds: string[];
  amountClaimed: string;
  currency: string;
}

/**
 * Create a dispute from analyst-accepted findings (P4.C.1): fetches the
 * named findings, validates them as one disputable claim (single carrier,
 * single currency, accepted status, UNDERCHARGE excluded -- see
 * validate-disputable-findings.ts), inserts one dispute + one dispute_line
 * per claimable finding, and transitions each finding to
 * 'queued_for_dispute' -- all inside the caller's tenant-scoped transaction.
 *
 * Idempotent for THIS call boundary only: findingIds are re-fetched by id and
 * filtered to status = 'accepted', so a byte-identical retry after success
 * (every finding already moved to queued_for_dispute) resolves to an empty
 * claimable set and fails closed (EMPTY_SET) rather than creating a second,
 * empty dispute. Preventing the SAME finding from being included in two
 * DIFFERENT dispute-creation calls across time is P4.C.2's boundary
 * ("prevent duplicate finding inclusion"), not solved here.
 */
export async function createDisputeFromFindings(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<CreateDisputeResult> {
  const input = schema.parse(untrusted);

  const { rows } = await client.query<FindingRow>(
    `SELECT vf.id, vf.status, i.carrier_id, vf.currency, vf.variance_amount, vf.direction
       FROM variance_finding vf
       JOIN audit_run ar ON ar.id = vf.audit_run_id AND ar.client_id = vf.client_id
       JOIN invoice i ON i.id = ar.invoice_id AND i.client_id = vf.client_id
      WHERE vf.client_id = $1 AND vf.id = ANY($2::uuid[])`,
    [input.clientId, input.findingIds],
  );

  const validated = validateDisputableFindings(
    rows.map((r) => ({
      id: r.id, status: r.status, carrierId: r.carrier_id,
      currency: r.currency, varianceAmount: r.variance_amount, direction: r.direction,
    })),
  );

  const dispute = await client.query<{ id: string }>(
    `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
     VALUES ($1,$2,'draft',$3,$4) RETURNING id`,
    [input.clientId, validated.carrierId, validated.amountClaimed, validated.currency],
  );
  const disputeId = dispute.rows[0]!.id;

  for (const findingRow of rows.filter((r) => validated.findingIds.includes(r.id))) {
    await client.query(
      `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.clientId, disputeId, findingRow.id, findingRow.variance_amount, findingRow.currency],
    );
    await updateFindingStatus(client, findingRow.id, 'queued_for_dispute', 'Included in dispute creation', input.actorUserId);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, disputeId, 'dispute.created'),
    clientId: input.clientId,
    entity: 'dispute',
    entityId: disputeId,
    event: 'dispute.created',
    actorKind: 'analyst',
    actorUserId: input.actorUserId ?? null,
    detail: { findingIds: validated.findingIds, amountClaimed: validated.amountClaimed, currency: validated.currency },
  });

  return {
    disputeId, findingIds: validated.findingIds,
    amountClaimed: validated.amountClaimed, currency: validated.currency,
  };
}
