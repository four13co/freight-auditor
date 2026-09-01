import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { APP_ROLE } from '../../src/db/pool.js';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { backtestContractRuleProposals } from '../../src/modules/contracts/backtest-contract-rule-proposals.js';
import { acceptContractRuleProposal } from '../../src/modules/contracts/accept-contract-rule-proposal.js';
import { ratifyContractRuleProposal } from '../../src/modules/contracts/ratify-contract-rule-proposal.js';
import { collectDiscoveryMetrics } from '../../src/jobs/discovery-metrics.js';

/**
 * Proves the RLS-visibility defect PR #159 shipped with (Review FAIL,
 * 2026-08-28 on task 86e2zfgwx): collectDiscoveryMetrics reads four
 * FORCE-ROW-LEVEL-SECURITY tables, and only a real transaction that sets the
 * app.* GUCs and drops into the freight_app role (withTenantTx / withAppTx)
 * can see rows in them. A query issued outside that scope fails closed --
 * this test seeds real rows through the actual domain functions (backtest ->
 * accept -> ratify, same chain as contract-rule-proposal-backtest.db.test.ts)
 * and asserts the counts are nonzero under the app role and zero without it.
 */
describe('discovery metrics (database)', () => {
  let pool: pg.Pool;
  const tag = `discovery-metrics-${Date.now()}`;
  const sha = createHash('sha256').update(tag).digest('hex');
  const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
  const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');

  let clientId: string; let userId: string; let carrierId: string; let sourceId: string;
  let contractId: string; let versionId: string; let verifiedId: string; let proposalId: string;

  async function committed<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantTxScope(client, { clientIds: [clientId] });
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Discovery Metrics',$1) RETURNING id`, [tag])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user(email) VALUES($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    sourceId = (await pool.query(`INSERT INTO source_document(client_id,sha256,content_type,byte_size,storage_uri)
      VALUES($1,$2,'application/pdf',1,$3) RETURNING id`, [clientId, sha, `local://${tag}`])).rows[0].id;
    contractId = (await pool.query(`INSERT INTO contract(client_id,carrier_id,name) VALUES($1,$2,'Discovery Metrics') RETURNING id`,
      [clientId, carrierId])).rows[0].id;
    versionId = (await pool.query(`INSERT INTO contract_version(client_id,contract_id,valid_from,source_document_id)
      VALUES($1,$2,'2026-01-01',$3) RETURNING id`, [clientId, contractId, sourceId])).rows[0].id;
    verifiedId = (await pool.query(`INSERT INTO verified_contract_version(client_id,contract_version_id,source_document_id,
      extraction_response_hash,verification_hash,resolved_fields,verified_by) VALUES($1,$2,$3,$4,$5,'[]',$6) RETURNING id`,
    [clientId, versionId, sourceId, 'a'.repeat(64), 'b'.repeat(64), userId])).rows[0].id;
    proposalId = (await pool.query(`INSERT INTO contract_rule_proposal(client_id,verified_contract_version_id,criterion_key,kind,
      rule_type,description,ast,ast_hash,expected_inputs,proposal_schema_version,provider,model_id,prompt_version,
      provider_message_id,request_key,source_document_sha256,extraction_response_hash,verification_hash,proposal_hash,actor_user_id)
      VALUES($1,$2,'CONTRACT.PROPOSED.FUEL_PRESENT','SCORING','CONTRACT_CONFORMANCE','Fuel present',$3,$4,$5,
      'proposed-criteria/1','anthropic','claude-opus-5','contract-proposed-criteria/1','msg-1',$6,$7,$8,$9,$10,$11) RETURNING id`,
    [clientId, verifiedId, JSON.stringify(ast), astHash, JSON.stringify(['has_fuel_category']), 'c'.repeat(64), sha,
      'a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64), userId])).rows[0].id;

    // PROPOSED -> backtest -> ACCEPTED (SHADOW) -> RATIFIED (ACTIVE): exercises
    // all three proposalsByLifecycle stages plus one ratification row.
    const backtest = await committed((client) => backtestContractRuleProposals(client, {
      clientId, verifiedContractVersionId: verifiedId, actorUserId: userId,
      corpusSchemaVersion: 'contract-proposal-backtest/1',
      proposals: [{ proposalId, cases: [{ caseKey: 'fuel-present', facts: { has_fuel_category: true }, expectedVerdict: 'PASS' }] }],
    }));
    const acceptance = await committed((client) => acceptContractRuleProposal(client, {
      clientId, proposalId, backtestId: backtest.backtestIds[0]!, actorUserId: userId,
      rationale: 'Reviewed citations and regression corpus.',
    }));
    await committed((client) => ratifyContractRuleProposal(client, {
      clientId, acceptanceId: acceptance.acceptanceId, actorUserId: userId,
      rationale: 'Human ratification after SHADOW review.',
    }));

    // An abstention (clarifying_question) and a human correction (extraction_field) --
    // the other two RLS-protected signal families the metrics module reads.
    await pool.query(`INSERT INTO clarifying_question(client_id,source_document_id,question,field_path,
      extraction_response_hash,abstention_status,abstention_reason,policy_version,question_hash)
      VALUES($1,$2,'What is the fuel surcharge basis?',$3,$4,'NOT_FOUND','LOW_CONFIDENCE','policy/1',$5)`,
    [clientId, sourceId, 'fuel_surcharge.basis', 'e'.repeat(64), 'f'.repeat(64)]);
    await pool.query(`INSERT INTO extraction_field(client_id,source_document_id,field_path,ai_value,human_value)
      VALUES($1,$2,'fuel_surcharge.basis','"unknown"'::jsonb,'"per_mile"'::jsonb)`, [clientId, sourceId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM extraction_field WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM clarifying_question WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal_ratification WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal_acceptance WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE source_contract_rule_proposal_id=$1)`, [proposalId]);
    await pool.query(`DELETE FROM rule_version WHERE source_contract_rule_proposal_id=$1`, [proposalId]);
    await pool.query(`DELETE FROM rule WHERE slug=$1`, [`contract-proposal-${proposalId}`]);
    await pool.query(`DELETE FROM contract_rule_proposal_backtest_case WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal_backtest WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal WHERE id=$1`, [proposalId]);
    await pool.query(`DELETE FROM verified_contract_version WHERE id=$1`, [verifiedId]);
    await pool.query(`DELETE FROM contract_version WHERE id=$1`, [versionId]);
    await pool.query(`DELETE FROM contract WHERE id=$1`, [contractId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceId]);
    await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id=$1`, [clientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]);
    await pool.end();
  });

  it('sees nonzero counts for every signal family under a real internal tenant transaction', async () => {
    const metrics = await withAppTx(pool, { internal: true }, collectDiscoveryMetrics);

    expect(metrics.aiProposalsByModel).toContainEqual({ modelId: 'claude-opus-5', promptVersion: 'contract-proposed-criteria/1', count: 1 });
    expect(metrics.abstentionsByReason).toContainEqual({ abstentionReason: 'LOW_CONFIDENCE', count: 1 });
    expect(metrics.humanTouchCorrections).toBeGreaterThanOrEqual(1);
    expect(metrics.humanTouchRatifications).toBeGreaterThanOrEqual(1);
    expect(metrics.proposalsByLifecycle).toContainEqual({ lifecycleStage: 'PROPOSED', count: expect.any(Number) });
    expect(metrics.proposalsByLifecycle.find((p) => p.lifecycleStage === 'ACCEPTED')?.count).toBeGreaterThanOrEqual(1);
    expect(metrics.proposalsByLifecycle.find((p) => p.lifecycleStage === 'RATIFIED')?.count).toBeGreaterThanOrEqual(1);
  });

  it('fails closed to zero rows under the app role when the tenant GUCs are never set (the PR #159 defect this guards against)', async () => {
    // FORCE ROW LEVEL SECURITY binds once the connection drops out of the
    // superuser/owner role into freight_app (non-BYPASSRLS) -- the policy then
    // admits a row only if app_is_internal() or the row's client_id is in
    // app_current_client_ids(). This transaction drops role WITHOUT calling
    // setTenantTxScope first, i.e. it reproduces exactly the shape PR #159's
    // collectDiscoveryMetrics ran in: a query issued through a role that binds
    // RLS but with no tenant context ever set. Every signal family must come
    // back empty/zero -- proving the read fails closed, not open, and that the
    // nonzero counts in the previous test are really coming from the GUC setup
    // withTenantTx/withAppTx perform, not from the freight_app role alone.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const metrics = await collectDiscoveryMetrics(client);
      expect(metrics.aiProposalsByModel).toEqual([]);
      expect(metrics.abstentionsByReason).toEqual([]);
      expect(metrics.humanTouchCorrections).toBe(0);
      expect(metrics.humanTouchRatifications).toBe(0);
      expect(metrics.proposalsByLifecycle.every((p) => p.count === 0)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
