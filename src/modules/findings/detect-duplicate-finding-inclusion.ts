import type pg from 'pg';
import { z } from 'zod';

const schema = z.object({
  clientId: z.uuid(),
  findingIds: z.array(z.uuid()).min(1).max(500),
});

/**
 * Detects findings that are already "spoken for" by an active dispute
 * lifecycle (P4.C.2): a finding moves to 'queued_for_dispute' the moment it
 * is included in a dispute (see update-finding-status.ts / P4.C.1's
 * createDisputeFromFindings), and stays there or moves to 'disputed' while
 * that dispute is live. Re-including such a finding in a second,
 * independent dispute-creation call would double-count the same
 * variance dollars.
 *
 * 'rejected' disputes are NOT tracked here: a finding whose dispute was
 * rejected is expected to return to a disputable status (e.g. 'accepted')
 * via P4.C.9's transition handling before being re-disputed -- that
 * transition, not this guard, is what makes it eligible again. This
 * function only ever sees the finding's CURRENT status, so a
 * correctly-reverted finding naturally falls out of the duplicate set
 * without this module needing to know anything about dispute outcomes.
 */
export interface DuplicateFindingInclusionResult {
  duplicateFindingIds: string[];
  eligibleFindingIds: string[];
}

const ALREADY_INCLUDED_STATUSES = ['queued_for_dispute', 'disputed'] as const;

export async function detectDuplicateFindingInclusion(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<DuplicateFindingInclusionResult> {
  const input = schema.parse(untrusted);

  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status
       FROM variance_finding
      WHERE client_id = $1 AND id = ANY($2::uuid[])`,
    [input.clientId, input.findingIds],
  );

  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  const duplicateFindingIds: string[] = [];
  const eligibleFindingIds: string[] = [];

  for (const id of input.findingIds) {
    const status = statusById.get(id);
    if (status !== undefined && (ALREADY_INCLUDED_STATUSES as readonly string[]).includes(status)) {
      duplicateFindingIds.push(id);
    } else {
      eligibleFindingIds.push(id);
    }
  }

  return { duplicateFindingIds, eligibleFindingIds };
}
