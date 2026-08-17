import type pg from 'pg';

export interface ResolvedCriterionIds {
  criterionId: string;
  ruleVersionId: string;
}

/**
 * Resolves a criterionKey to its seeded criterion_id/rule_version_id pair.
 * Returns null (never throws) when the key has no seeded row -- both columns
 * are nullable on charge_finding/variance_finding (migration 0008), and a
 * caller must be able to write a finding for a criterion that predates this
 * seed step or was added to a rubric after the last seed run, without that
 * failing the whole persist.
 *
 * Lives in src/ (not scripts/seed-criteria.mjs, which owns the seeding side)
 * so persist.ts can import it as a plain compiled dependency -- seed-criteria.mjs
 * pulls in STANDARD_RUBRIC/CONTRACT_RUBRIC via ../src/... relative imports that
 * only resolve under tsx, not under `node dist/...` (production's actual
 * runtime). This function has no rubric dependency, so it doesn't carry that
 * constraint.
 */
export async function resolveCriterionIds(
  client: pg.Pool | pg.PoolClient,
  criterionKey: string,
): Promise<ResolvedCriterionIds | null> {
  const critRes = await client.query<{ id: string }>(`SELECT id FROM criterion WHERE criterion_key = $1`, [criterionKey]);
  if (critRes.rows.length === 0) return null;
  const criterionId = critRes.rows[0]!.id;

  const ruleSlug = criterionKey.toLowerCase().replace(/\./g, '-');
  const ruleVersionRes = await client.query<{ id: string }>(
    `SELECT rule_version.id
     FROM rule_version
     JOIN rule ON rule.id = rule_version.rule_id
     WHERE rule.slug = $1
     ORDER BY rule_version.recorded_at DESC
     LIMIT 1`,
    [ruleSlug],
  );
  if (ruleVersionRes.rows.length === 0) return null;

  return { criterionId, ruleVersionId: ruleVersionRes.rows[0]!.id };
}
