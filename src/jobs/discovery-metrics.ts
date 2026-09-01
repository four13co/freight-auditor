import type pg from 'pg';

/**
 * Aggregate-only observability for the discovery/proposal pipeline (P3.D.9):
 * counts, never tenant-identifying rows -- dimensioned by model/prompt version,
 * abstention reason, and lifecycle stage, never by client_id.
 *
 * The four source tables (contract_rule_proposal, clarifying_question,
 * extraction_field, contract_rule_proposal_ratification) all carry FORCE ROW
 * LEVEL SECURITY, so this reads through `withTenantTx({ internal: true })`
 * (portfolio-wide read, still RLS-bound) rather than a raw pool/boss handle --
 * a query issued outside a tenant transaction runs with an empty GUC scope and
 * fails closed (zero rows), never open. See src/worker/metrics.ts for the call
 * site and test/db/discovery-metrics.db.test.ts for the RLS-visibility proof.
 *
 * "AI-call" is counted as freight_ai_proposals_total: a contract_rule_proposal
 * row is durable evidence of one *successful* structured-output call
 * (VersionedAnthropicProvider has no separate call log -- a failed or
 * retried call leaves no row anywhere). Naming it "proposals" rather than
 * "calls" says that honestly; see the module's PR for the full rationale.
 */
export interface DiscoveryMetrics {
  aiProposalsByModel: Array<{ modelId: string; promptVersion: string; count: number }>;
  abstentionsByReason: Array<{ abstentionReason: string; count: number }>;
  humanTouchCorrections: number;
  humanTouchRatifications: number;
  proposalsByLifecycle: Array<{ lifecycleStage: 'PROPOSED' | 'ACCEPTED' | 'RATIFIED'; count: number }>;
}

interface AiProposalRow { model_id: string; prompt_version: string; count: string | number }
interface AbstentionRow { abstention_reason: string; count: string | number }
interface LifecycleRow { lifecycle_stage: 'PROPOSED' | 'ACCEPTED' | 'RATIFIED'; count: string | number }
interface HumanTouchRow { corrections: string | number; ratifications: string | number }

const AI_PROPOSALS_SQL = `
  SELECT model_id, prompt_version, count(*) AS count
  FROM contract_rule_proposal
  GROUP BY model_id, prompt_version
`;

const ABSTENTIONS_SQL = `
  SELECT abstention_reason, count(*) AS count
  FROM clarifying_question
  WHERE abstention_reason IS NOT NULL
  GROUP BY abstention_reason
`;

const HUMAN_TOUCH_SQL = `
  SELECT
    (SELECT count(*) FROM extraction_field WHERE human_value IS NOT NULL) AS corrections,
    (SELECT count(*) FROM contract_rule_proposal_ratification) AS ratifications
`;

const PROPOSALS_BY_LIFECYCLE_SQL = `
  SELECT 'PROPOSED' AS lifecycle_stage, count(*) AS count FROM contract_rule_proposal
  UNION ALL
  SELECT 'ACCEPTED', count(*) FROM contract_rule_proposal_acceptance
  UNION ALL
  SELECT 'RATIFIED', count(*) FROM contract_rule_proposal_ratification
`;

export async function collectDiscoveryMetrics(client: pg.PoolClient): Promise<DiscoveryMetrics> {
  const [aiProposals, abstentions, humanTouch, proposalsByLifecycle] = await Promise.all([
    client.query(AI_PROPOSALS_SQL, []),
    client.query(ABSTENTIONS_SQL, []),
    client.query(HUMAN_TOUCH_SQL, []),
    client.query(PROPOSALS_BY_LIFECYCLE_SQL, []),
  ]);
  const humanTouchRow = (humanTouch.rows as HumanTouchRow[])[0];
  return {
    aiProposalsByModel: (aiProposals.rows as AiProposalRow[]).map((r) => ({
      modelId: r.model_id, promptVersion: r.prompt_version, count: Number(r.count),
    })),
    abstentionsByReason: (abstentions.rows as AbstentionRow[]).map((r) => ({
      abstentionReason: r.abstention_reason, count: Number(r.count),
    })),
    humanTouchCorrections: Number(humanTouchRow?.corrections ?? 0),
    humanTouchRatifications: Number(humanTouchRow?.ratifications ?? 0),
    proposalsByLifecycle: (proposalsByLifecycle.rows as LifecycleRow[]).map((r) => ({
      lifecycleStage: r.lifecycle_stage, count: Number(r.count),
    })),
  };
}

function label(pairs: Record<string, string>): string {
  const escape = (v: string) => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return Object.entries(pairs).map(([k, v]) => `${k}="${escape(v)}"`).join(',');
}

export function renderDiscoveryMetrics(metrics: DiscoveryMetrics): string {
  const lines = [
    '# TYPE freight_ai_proposals_total counter',
    ...metrics.aiProposalsByModel.map((m) =>
      `freight_ai_proposals_total{${label({ model_id: m.modelId, prompt_version: m.promptVersion })}} ${m.count}`),
    '# TYPE freight_discovery_abstentions_total counter',
    ...metrics.abstentionsByReason.map((a) =>
      `freight_discovery_abstentions_total{${label({ abstention_reason: a.abstentionReason })}} ${a.count}`),
    '# TYPE freight_discovery_human_touch_total counter',
    `freight_discovery_human_touch_total{${label({ kind: 'extraction_correction' })}} ${metrics.humanTouchCorrections}`,
    `freight_discovery_human_touch_total{${label({ kind: 'proposal_ratification' })}} ${metrics.humanTouchRatifications}`,
    '# TYPE freight_contract_rule_proposals_total counter',
    ...metrics.proposalsByLifecycle.map((p) =>
      `freight_contract_rule_proposals_total{${label({ lifecycle_stage: p.lifecycleStage })}} ${p.count}`),
  ];
  return `${lines.join('\n')}\n`;
}
