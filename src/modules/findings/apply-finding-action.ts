import type pg from 'pg';
import { updateFindingStatus, type UpdateFindingStatusResult } from './update-finding-status.js';

export const FINDING_ACTION_STATUS = { accept: 'accepted', waive: 'waived', escalate: 'in_review' } as const;
export type FindingAction = keyof typeof FINDING_ACTION_STATUS;

export async function applyFindingAction(client: pg.PoolClient, input: {
  findingId: string; action: FindingAction; note?: string; actorUserId?: string;
}): Promise<UpdateFindingStatusResult & { status: string }> {
  const status = FINDING_ACTION_STATUS[input.action];
  const result = await updateFindingStatus(client, input.findingId, status,
    input.note ?? `Analyst action: ${input.action}`, input.actorUserId);
  return { ...result, status };
}
