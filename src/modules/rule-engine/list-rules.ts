import type pg from 'pg';

export type RuleListSortKey = 'name' | 'tier' | 'type' | 'status' | 'lastModified';
export type SortDirection = 'asc' | 'desc';

export interface ListRulesOptions {
  tier?: 'STANDARD' | 'CLIENT' | 'CONTRACT';
  kind?: 'GATING' | 'SCORING';
  status?: 'PROPOSED' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'QUARANTINED';
  sortKey?: RuleListSortKey;
  sortDirection?: SortDirection;
  limit: number;
  offset: number;
}

export interface RuleListRow {
  ruleVersionId: string;
  ruleId: string;
  slug: string;
  ruleType: string;
  tier: 'STANDARD' | 'CLIENT' | 'CONTRACT' | null;
  kind: 'GATING' | 'SCORING' | null;
  status: string;
  hardness: string;
  lastModified: Date;
}

export interface ListRulesResult {
  rows: RuleListRow[];
  total: number;
}

const SORT_COLUMNS: Record<RuleListSortKey, string> = {
  name: 'r.slug',
  tier: 'picked_rb.tier',
  type: 'crit.kind',
  status: 'rv.lifecycle_state',
  lastModified: 'rv.recorded_at',
};

/**
 * 86e3a6rg1: rule/rule_version carry no "tier" or "Gating/Scoring type" of
 * their own -- those live on the rubric (rubric.tier) and criterion
 * (criterion.kind) a rule is wired to via criterion_rule ->
 * criterion_version -> criterion_membership -> rubric_version -> rubric.
 * That chain is many-to-many in the general case (one rule could in
 * principle back criteria in more than one rubric/tier); this picks ONE
 * representative criterion (PRIMARY role first, then lowest rank) and ONE
 * representative rubric tier for display, deterministically, rather than
 * building the fully general "this rule appears in N tiers" model -- a
 * disclosed simplification (see this PR's Uncertainties), not a bug in the
 * common case where a rule serves exactly one criterion.
 *
 * "Current" version = the rule_version with no successor row (append-only
 * chain via predecessor_rule_version_id), same predicate the existing
 * /api/rules/proposals query already uses for PROPOSED/SHADOW -- generalized
 * here to every lifecycle state so ACTIVE/DEPRECATED/QUARANTINED rules show
 * their current row too, not just proposals.
 */
export async function listRules(client: pg.PoolClient, options: ListRulesOptions): Promise<ListRulesResult> {
  const conditions: string[] = [
    'NOT EXISTS (SELECT 1 FROM rule_version successor WHERE successor.predecessor_rule_version_id = rv.id)',
  ];
  const params: unknown[] = [];

  if (options.status) {
    params.push(options.status);
    conditions.push(`rv.lifecycle_state = $${params.length}::rule_lifecycle`);
  }
  if (options.kind) {
    params.push(options.kind);
    conditions.push(`crit.kind = $${params.length}::criterion_kind`);
  }
  if (options.tier) {
    params.push(options.tier);
    conditions.push(`picked_rb.tier = $${params.length}::rubric_tier`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const sortColumn = SORT_COLUMNS[options.sortKey ?? 'lastModified'];
  const direction = options.sortDirection === 'asc' ? 'ASC' : 'DESC';

  const fromAndJoins = `
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
  `;

  const countResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count ${fromAndJoins} ${where}`,
    params,
  );

  const limitParamIdx = params.length + 1;
  const offsetParamIdx = params.length + 2;
  const rowsResult = await client.query<{
    rule_version_id: string; rule_id: string; slug: string; rule_type: string;
    tier: 'STANDARD' | 'CLIENT' | 'CONTRACT' | null; kind: 'GATING' | 'SCORING' | null;
    lifecycle_state: string; hardness: string; recorded_at: Date;
  }>(
    `SELECT rv.id AS rule_version_id, r.id AS rule_id, r.slug, r.rule_type,
            picked_rb.tier, crit.kind, rv.lifecycle_state, rv.hardness, rv.recorded_at
       ${fromAndJoins}
       ${where}
       ORDER BY ${sortColumn} ${direction}, rv.id ASC
       LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
    [...params, options.limit, options.offset],
  );

  return {
    total: Number(countResult.rows[0]?.count ?? '0'),
    rows: rowsResult.rows.map((r) => ({
      ruleVersionId: r.rule_version_id,
      ruleId: r.rule_id,
      slug: r.slug,
      ruleType: r.rule_type,
      tier: r.tier,
      kind: r.kind,
      status: r.lifecycle_state,
      hardness: r.hardness,
      lastModified: r.recorded_at,
    })),
  };
}
