import type pg from 'pg';
import { z } from 'zod';

const RuleType = z.enum(['STRUCTURAL', 'INTRA_LINE', 'CROSS_REFERENCE', 'CONTRACT_CONFORMANCE',
  'EXTERNAL_REFERENCE', 'CROSS_DOCUMENT', 'POLICY_ELIGIBILITY']);
const PolicyInput = z.object({ clientId: z.uuid(), ruleType: RuleType,
  n1Confirm: z.number().int().positive(), n2Confirm: z.number().int().positive(), maxReversals: z.number().int().nonnegative() })
  .refine((v) => v.n2Confirm >= v.n1Confirm, { message: 'n2Confirm must be greater than or equal to n1Confirm' });
export type PromotionPolicyInput = z.infer<typeof PolicyInput>;
export interface PromotionPolicy { clientId: string | null; ruleType: z.infer<typeof RuleType> | null; n1Confirm: number; n2Confirm: number; maxReversals: number }
export class InvalidPromotionPolicyError extends Error { readonly code = 'INVALID_PROMOTION_POLICY'; }

export async function upsertPromotionPolicy(client: pg.PoolClient, untrusted: unknown): Promise<PromotionPolicy> {
  const parsed = PolicyInput.safeParse(untrusted);
  if (!parsed.success) throw new InvalidPromotionPolicyError(parsed.error.issues[0]?.message ?? 'invalid promotion policy');
  const v = parsed.data;
  const row = (await client.query<{ client_id: string; rule_type: PromotionPolicy['ruleType']; n1_confirm: number; n2_confirm: number; max_reversals: number }>(
    `INSERT INTO promotion_policy (client_id, rule_type, n1_confirm, n2_confirm, max_reversals)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, rule_type) DO UPDATE SET
       n1_confirm=EXCLUDED.n1_confirm, n2_confirm=EXCLUDED.n2_confirm, max_reversals=EXCLUDED.max_reversals
     RETURNING client_id, rule_type, n1_confirm, n2_confirm, max_reversals`,
    [v.clientId, v.ruleType, v.n1Confirm, v.n2Confirm, v.maxReversals])).rows[0]!;
  return { clientId: row.client_id, ruleType: row.rule_type, n1Confirm: row.n1_confirm, n2Confirm: row.n2_confirm, maxReversals: row.max_reversals };
}

export async function resolvePromotionPolicy(client: pg.PoolClient, clientId: string, ruleType: z.infer<typeof RuleType>): Promise<PromotionPolicy> {
  const row = (await client.query<{ client_id: string | null; rule_type: PromotionPolicy['ruleType']; n1_confirm: number; n2_confirm: number; max_reversals: number }>(
    `SELECT client_id, rule_type, n1_confirm, n2_confirm, max_reversals FROM promotion_policy
     WHERE (client_id=$1 OR client_id IS NULL) AND (rule_type=$2 OR rule_type IS NULL)
     ORDER BY (client_id IS NOT NULL) DESC, (rule_type IS NOT NULL) DESC LIMIT 1`, [clientId, ruleType])).rows[0];
  if (!row) throw new Error(`promotion policy not found: ${ruleType}`);
  return { clientId: row.client_id, ruleType: row.rule_type, n1Confirm: row.n1_confirm, n2Confirm: row.n2_confirm, maxReversals: row.max_reversals };
}
