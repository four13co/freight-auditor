import { describe, expect, it, vi } from 'vitest';
import { collectDiscoveryMetrics, renderDiscoveryMetrics } from '../../src/jobs/discovery-metrics.js';

describe('discovery metrics', () => {
  it('collects AI-proposal, abstention, human-touch, and proposal-lifecycle counts', async () => {
    const executeSql = vi.fn()
      .mockResolvedValueOnce({ rows: [{ model_id: 'claude-sonnet-5', prompt_version: 'v3', count: '7' }] }) // ai proposals
      .mockResolvedValueOnce({ rows: [{ abstention_reason: 'LOW_CONFIDENCE', count: '4' }] }) // abstentions
      .mockResolvedValueOnce({ rows: [{ corrections: '12', ratifications: '2' }] }) // human touch
      .mockResolvedValueOnce({ rows: [ // proposal lifecycle
        { lifecycle_stage: 'PROPOSED', count: '7' },
        { lifecycle_stage: 'ACCEPTED', count: '3' },
        { lifecycle_stage: 'RATIFIED', count: '2' },
      ] });

    const metrics = await collectDiscoveryMetrics({ executeSql });

    expect(executeSql).toHaveBeenCalledTimes(4);
    expect(executeSql).toHaveBeenCalledWith(expect.stringContaining('FROM contract_rule_proposal'), []);
    expect(executeSql).toHaveBeenCalledWith(expect.stringContaining('FROM clarifying_question'), []);
    expect(executeSql).toHaveBeenCalledWith(expect.stringContaining('extraction_field'), []);
    expect(metrics).toEqual({
      aiProposalsByModel: [{ modelId: 'claude-sonnet-5', promptVersion: 'v3', count: 7 }],
      abstentionsByReason: [{ abstentionReason: 'LOW_CONFIDENCE', count: 4 }],
      humanTouchCorrections: 12,
      humanTouchRatifications: 2,
      proposalsByLifecycle: [
        { lifecycleStage: 'PROPOSED', count: 7 },
        { lifecycleStage: 'ACCEPTED', count: 3 },
        { lifecycleStage: 'RATIFIED', count: 2 },
      ],
    });
  });

  it('defaults human-touch counts to zero when the aggregate row is empty', async () => {
    const executeSql = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const metrics = await collectDiscoveryMetrics({ executeSql });

    expect(metrics.humanTouchCorrections).toBe(0);
    expect(metrics.humanTouchRatifications).toBe(0);
    expect(metrics.aiProposalsByModel).toEqual([]);
    expect(metrics.abstentionsByReason).toEqual([]);
    expect(metrics.proposalsByLifecycle).toEqual([]);
  });

  it('renders scrape-compatible metrics for every required signal, with no client_id dimension anywhere', () => {
    const text = renderDiscoveryMetrics({
      aiProposalsByModel: [{ modelId: 'claude-sonnet-5', promptVersion: 'v3', count: 7 }],
      abstentionsByReason: [{ abstentionReason: 'LOW_CONFIDENCE', count: 4 }],
      humanTouchCorrections: 12,
      humanTouchRatifications: 2,
      proposalsByLifecycle: [
        { lifecycleStage: 'PROPOSED', count: 7 },
        { lifecycleStage: 'ACCEPTED', count: 3 },
        { lifecycleStage: 'RATIFIED', count: 2 },
      ],
    });

    expect(text).toContain('freight_ai_proposals_total{model_id="claude-sonnet-5",prompt_version="v3"} 7');
    expect(text).toContain('freight_discovery_abstentions_total{abstention_reason="LOW_CONFIDENCE"} 4');
    expect(text).toContain('freight_discovery_human_touch_total{kind="extraction_correction"} 12');
    expect(text).toContain('freight_discovery_human_touch_total{kind="proposal_ratification"} 2');
    expect(text).toContain('freight_contract_rule_proposals_total{lifecycle_stage="PROPOSED"} 7');
    expect(text).toContain('freight_contract_rule_proposals_total{lifecycle_stage="ACCEPTED"} 3');
    expect(text).toContain('freight_contract_rule_proposals_total{lifecycle_stage="RATIFIED"} 2');
    expect(text).not.toMatch(/client_id/);
  });

  it('escapes label values containing quotes or backslashes', () => {
    const text = renderDiscoveryMetrics({
      aiProposalsByModel: [{ modelId: 'weird"model\\v1', promptVersion: 'v1', count: 1 }],
      abstentionsByReason: [],
      humanTouchCorrections: 0,
      humanTouchRatifications: 0,
      proposalsByLifecycle: [],
    });
    expect(text).toContain('model_id="weird\\"model\\\\v1"');
  });
});
