import type pg from 'pg';
import { z } from 'zod';

export const ACTIVE_RULE_RESOLVER_VERSION = 'active-rule-resolver-v1';
const RequestSchema = z.object({
  ruleId: z.string().uuid(),
  effectiveOn: z.iso.date(),
  recordedAsOf: z.iso.datetime({ offset: true }),
}).strict();

export type RuleHardness = 'HUMAN_INPUT' | 'AI_CANON' | 'AI_DOCS' | 'FIRM_RULE';
export type ActiveRuleResolution =
  | { status: 'FOUND'; ruleVersionId: string; hardness: RuleHardness; astHash: string; resolverVersion: string }
  | { status: 'UNAVAILABLE'; reason: 'NO_ACTIVE_VERSION'; resolverVersion: string };

export class ActiveRuleRequestError extends Error {
  readonly code = 'ACTIVE_RULE_REQUEST_INVALID';
  constructor() {
    super('Invalid active rule resolution request');
    this.name = 'ActiveRuleRequestError';
  }
}

export async function resolveActiveRuleVersion(
  client: pg.PoolClient,
  untrustedRequest: unknown,
): Promise<ActiveRuleResolution> {
  const parsed = RequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) throw new ActiveRuleRequestError();
  const request = parsed.data;
  const row = (await client.query<{ id: string; hardness: RuleHardness; ast_hash: string }>(
    `SELECT id, hardness, ast_hash FROM rule_version
     WHERE rule_id = $1 AND lifecycle_state = 'ACTIVE'
       AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to > $2::date)
       AND recorded_at <= $3::timestamptz
     ORDER BY CASE hardness
       WHEN 'FIRM_RULE' THEN 4 WHEN 'AI_DOCS' THEN 3
       WHEN 'AI_CANON' THEN 2 WHEN 'HUMAN_INPUT' THEN 1 END DESC,
       valid_from DESC, recorded_at DESC, id DESC
     LIMIT 1`,
    [request.ruleId, request.effectiveOn, request.recordedAsOf],
  )).rows[0];
  if (!row) return { status: 'UNAVAILABLE', reason: 'NO_ACTIVE_VERSION', resolverVersion: ACTIVE_RULE_RESOLVER_VERSION };
  return {
    status: 'FOUND', ruleVersionId: row.id, hardness: row.hardness,
    astHash: row.ast_hash, resolverVersion: ACTIVE_RULE_RESOLVER_VERSION,
  };
}
