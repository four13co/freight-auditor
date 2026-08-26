import { describe, expect, it, vi } from 'vitest';
import { applyFindingAction, FINDING_ACTION_STATUS } from '../../src/modules/findings/apply-finding-action.js';

describe('finding review actions', () => {
  it('maps only the three public actions to canonical statuses', () => {
    expect(FINDING_ACTION_STATUS).toEqual({ accept: 'accepted', waive: 'waived', escalate: 'in_review' });
  });
  it('persists status history and audit evidence through the shared service', async () => {
    const findingId = crypto.randomUUID(); const clientId = crypto.randomUUID(); const statusEventId = crypto.randomUUID(); const actorUserId = crypto.randomUUID();
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: findingId, client_id: clientId, from_status: 'open', status_event_id: statusEventId }] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit' }] });
    await expect(applyFindingAction({ query } as never, { findingId, action: 'accept', actorUserId }))
      .resolves.toEqual({ found: true, status: 'accepted' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
