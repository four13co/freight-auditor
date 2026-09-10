import { describe, expect, it, vi } from 'vitest';
import { promoteShadowRule, DualControlRequiredError } from '../../src/modules/rule-engine/promote-shadow-rule.js';

const RATIFIER = 'ratifier-1';
const ACTIVATOR = 'activator-2';

describe('promoteShadowRule', () => {
  it('rejects activation by the same analyst who ratified the rule version', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ actor_user_id: RATIFIER }] });
    await expect(promoteShadowRule({ query } as never, { ruleVersionId: 'rv', rationale: 'x', actorUserId: RATIFIER }))
      .rejects.toThrow(DualControlRequiredError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects activation when no ratification event is on record for this rule version', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(promoteShadowRule({ query } as never, { ruleVersionId: 'rv', rationale: 'x', actorUserId: ACTIVATOR }))
      .rejects.toThrow(DualControlRequiredError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('promotes to ACTIVE when a different analyst activates than the one who ratified', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ actor_user_id: RATIFIER }] })
      .mockResolvedValueOnce({ rows: [{ lifecycle_state: 'SHADOW' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'active' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(promoteShadowRule({ query } as never, { ruleVersionId: 'rv', rationale: 'passed', actorUserId: ACTIVATOR }))
      .resolves.toEqual({ ruleVersionId: 'active', created: true });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
