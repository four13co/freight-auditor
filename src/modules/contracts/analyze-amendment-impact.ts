import type pg from 'pg';

export interface ClauseImpact { clauseReference: string; change: 'ADDED' | 'REMOVED' | 'CHANGED'; oldClauseId: string | null; newClauseId: string | null; affectedRuleVersionIds: string[] }
export async function analyzeAmendmentImpact(client: pg.PoolClient, input: { clientId: string; amendmentId: string }): Promise<ClauseImpact[]> {
  const amendment = (await client.query<{ supersedes_version_id: string | null; new_version_id: string | null }>(
    `SELECT supersedes_version_id, new_version_id FROM contract_amendment WHERE id=$1 AND client_id=$2`,
    [input.amendmentId, input.clientId])).rows[0];
  if (!amendment) throw new Error(`contract amendment not found for tenant: ${input.amendmentId}`);
  if (!amendment.supersedes_version_id || !amendment.new_version_id) throw new Error('contract amendment must link old and new versions');
  const rows = (await client.query<{
    clause_ref: string; old_clause_id: string | null; new_clause_id: string | null; old_text: string | null; new_text: string | null;
  }>(`SELECT coalesce(o.clause_ref,n.clause_ref) clause_ref, o.id old_clause_id, n.id new_clause_id,
      o.text_excerpt old_text, n.text_excerpt new_text
    FROM contract_clause o FULL OUTER JOIN contract_clause n ON n.contract_version_id=$2 AND n.clause_ref=o.clause_ref
    WHERE o.contract_version_id=$1 OR (o.id IS NULL AND n.contract_version_id=$2)
    ORDER BY coalesce(o.clause_ref,n.clause_ref)`, [amendment.supersedes_version_id, amendment.new_version_id])).rows;
  const impacts: ClauseImpact[] = [];
  for (const row of rows) {
    const change = !row.old_clause_id ? 'ADDED' : !row.new_clause_id ? 'REMOVED'
      : row.old_text !== row.new_text ? 'CHANGED' : null;
    if (!change) continue;
    const affected = row.old_clause_id ? (await client.query<{ id: string }>(
      `SELECT id FROM rule_version WHERE clause_id=$1 AND lifecycle_state='ACTIVE' ORDER BY id`, [row.old_clause_id])).rows.map((r) => r.id) : [];
    impacts.push({ clauseReference: row.clause_ref, change, oldClauseId: row.old_clause_id,
      newClauseId: row.new_clause_id, affectedRuleVersionIds: affected });
  }
  return impacts;
}
