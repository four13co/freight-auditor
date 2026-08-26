import { describe, expect, it } from 'vitest';
import { FINDING_ACTION_STATUS } from '../../src/modules/findings/apply-finding-action.js';

describe('finding review actions', () => {
  it('maps only the three public actions to canonical statuses', () => {
    expect(FINDING_ACTION_STATUS).toEqual({ accept: 'accepted', waive: 'waived', escalate: 'in_review' });
  });
});
