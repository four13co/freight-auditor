import type pg from 'pg';

export interface RulePromotionEventRow {
  id: string;
  fromLifecycle: string | null;
  toLifecycle: string | null;
  direction: string;
  rationale: string | null;
  recordedAt: Date;
}

export interface RuleDetail {
  ruleVersionId: string;
  ruleId: string;
  slug: string;
  ruleType: string;
  tier: 'STANDARD' | 'CLIENT' | 'CONTRACT' | null;
  kind: 'GATING' | 'SCORING' | null;
  status: string;
  hardness: string;
  emits: string;
  ast: unknown;
  expectedInputs: unknown;
  provenance: unknown;
  clauseId: string | null;
  validFrom: string;
  validTo: string | null;
  recordedAt: Date;
  history: RulePromotionEventRow[];
}

/**
 * Detail view for one rule (86e3a6rg1): the same tier/kind derivation as
 * list-rules.ts (see that module's header comment for why it's a
 * deterministic-pick simplification, not the fully general many-rubric
 * model), plus the full predicate AST and this rule's promotion_event
 * history so a reviewer can see how it got to its current lifecycle state.
 */
export async function getRuleDetail(client: pg.PoolClient, ruleVersionId: string): Promise<RuleDetail | null> {
  const result = await client.query<{
    rule_version_id: string; rule_id: string; slug: string; rule_type: string;
    tier: 'STANDARD' | 'CLIENT' | 'CONTRACT' | null; kind: 'GATING' | 'SCORING' | null;
    lifecycle_state: string; hardness: string; emits: string; ast: unknown; expected_inputs: unknown;
    provenance: unknown; clause_id: string | null; valid_from: string; valid_to: string | null; recorded_at: Date;
  }>(
    `SELECT rv.id AS rule_version_id, r.id AS rule_id, r.slug, r.rule_type,
            picked_rb.tier, crit.kind, rv.lifecycle_state, rv.hardness, rv.emits, rv.ast, rv.expected_inputs,
            rv.provenance, rv.clause_id, rv.valid_from, rv.valid_to, rv.recorded_at
       FROM rule_version rv
       JOIN rule r ON r.id = rv.rule_id
       LEFT JOIN LATERAL (
         SELECT cr.criterion_version_id
           FROM criterion_rule cr
          WHERE cr.rule_id = r.id
          ORDER BY (cr.role = 'PRIMARY') DESC, cr.rank ASC
          LIMIT 1
       ) picked_cr ON true
       LEFT JOIN criterion_version cv ON cv.id = picked_cr.criterion_version_id
       LEFT JOIN criterion crit ON crit.id = cv.criterion_id
       LEFT JOIN LATERAL (
         SELECT rb2.tier
           FROM criterion_membership cm
           JOIN rubric_version rbv2 ON rbv2.id = cm.rubric_version_id
           JOIN rubric rb2 ON rb2.id = rbv2.rubric_id
          WHERE cm.criterion_key = crit.criterion_key
          ORDER BY rb2.tier
          LIMIT 1
       ) picked_rb ON true
      WHERE rv.id = $1`,
    [ruleVersionId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const history = await client.query<{
    id: string; from_lifecycle: string | null; to_lifecycle: string | null;
    direction: string; rationale: string | null; recorded_at: Date;
  }>(
    `SELECT pe.id, pe.from_lifecycle, pe.to_lifecycle, pe.direction, pe.rationale, pe.recorded_at
       FROM promotion_event pe
      WHERE pe.rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)
      ORDER BY pe.recorded_at ASC`,
    [row.rule_id],
  );

  return {
    ruleVersionId: row.rule_version_id,
    ruleId: row.rule_id,
    slug: row.slug,
    ruleType: row.rule_type,
    tier: row.tier,
    kind: row.kind,
    status: row.lifecycle_state,
    hardness: row.hardness,
    emits: row.emits,
    ast: row.ast,
    expectedInputs: row.expected_inputs,
    provenance: row.provenance,
    clauseId: row.clause_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    recordedAt: row.recorded_at,
    history: history.rows.map((h) => ({
      id: h.id,
      fromLifecycle: h.from_lifecycle,
      toLifecycle: h.to_lifecycle,
      direction: h.direction,
      rationale: h.rationale,
      recordedAt: h.recorded_at,
    })),
  };
}
