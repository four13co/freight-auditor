import type pg from 'pg';

export async function getRubricSnapshot(client: pg.PoolClient, auditRunId: string): Promise<unknown | null> {
  return (await client.query(`SELECT rs.id, rs.content_hash, rs.resolver_version, rs.resolved, rs.created_at
    FROM audit_run ar JOIN rubric_snapshot rs ON rs.id = ar.rubric_snapshot_id
    WHERE ar.id = $1`, [auditRunId])).rows[0] ?? null;
}

export async function listResolutionConflicts(client: pg.PoolClient, auditRunId: string): Promise<unknown[]> {
  return (await client.query(`SELECT rc.id, rc.criterion_key, rc.conflict_type, rc.reason_code,
      rc.source_rubric_version_ids, rc.source_rule_version_ids, rc.resolver_version, rc.recorded_at
    FROM audit_run ar JOIN resolution_conflict rc ON rc.rubric_snapshot_id = ar.rubric_snapshot_id
    WHERE ar.id = $1 ORDER BY rc.recorded_at, rc.id`, [auditRunId])).rows;
}

export async function getReplayManifest(client: pg.PoolClient, auditRunId: string): Promise<unknown | null> {
  return (await client.query(`SELECT audit_run_id, content_hash, manifest, created_at
    FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId])).rows[0] ?? null;
}
