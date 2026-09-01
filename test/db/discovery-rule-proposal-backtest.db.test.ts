import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { backtestDiscoveryRuleProposals, DiscoveryProposalBacktestError } from '../../src/modules/discovery/backtest-discovery-rule-proposals.js';
import { acceptDiscoveryRuleProposal } from '../../src/modules/discovery/accept-discovery-rule-proposal.js';

describe('discovery proposal backtest and SHADOW acceptance (DB)', () => {
  let pool: pg.Pool;
  const tag = `discovery-proposal-backtest-${Date.now()}`;
  const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
  const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');
  let clientId: string; let otherClientId: string; let userId: string; let carrierId: string;
  let invoiceId: string; let auditRunId: string; let unknownCodeTriggerId: string; let chargeFactId: string;
  let proposalId: string; let passingBacktestId: string;

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('DiscoveryBacktest',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user(email) VALUES($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    invoiceId = (await pool.query(`INSERT INTO invoice(client_id,carrier_id,transaction_set,invoice_number,currency,parser_version)
      VALUES($1,$2,'210',$3,'USD','test') RETURNING id`, [clientId, carrierId, `INV-${tag}`])).rows[0].id;
    auditRunId = (await pool.query(`INSERT INTO audit_run(client_id,invoice_id,engine_spec_version,outcome)
      VALUES($1,$2,'test','DISCOVERY_PENDING') RETURNING id`, [clientId, invoiceId])).rows[0].id;
    chargeFactId = (await pool.query(`INSERT INTO charge_fact(client_id,invoice_id,code,x12_element,amount,currency)
      VALUES($1,$2,'ZZZ','C302-02',10,'USD') RETURNING id`, [clientId, invoiceId])).rows[0].id;
    unknownCodeTriggerId = (await pool.query(`INSERT INTO unknown_charge_code_trigger(client_id,audit_run_id,charge_fact_id,source_code,x12_element,detail)
      VALUES($1,$2,$3,'ZZZ','C302-02','{}'::jsonb) RETURNING id`, [clientId, auditRunId, chargeFactId])).rows[0].id;
    proposalId = (await pool.query(`INSERT INTO discovery_rule_proposal(client_id,audit_run_id,unknown_charge_code_trigger_id,criterion_key,kind,
      rule_type,description,ast,ast_hash,expected_inputs,proposal_schema_version,provider,model_id,prompt_version,provider_message_id,
      request_key,proposal_hash,actor_user_id)
      VALUES($1,$2,$3,'DISCOVERY.PROPOSED.UNKNOWN_CODE_ZZZ','SCORING','EXTERNAL_REFERENCE','Charge code ZZZ should resolve to a known category.',
      $4,$5,$6,'discovery-rule-proposal/1','anthropic','claude-opus-5','discovery-rule-proposal/1','msg-1',$7,$8,$9) RETURNING id`,
    [clientId, auditRunId, unknownCodeTriggerId, JSON.stringify(ast), astHash, JSON.stringify(['has_fuel_category']),
      'c'.repeat(64), 'd'.repeat(64), userId])).rows[0].id;
  });

  const input = (expectedVerdict: 'PASS' | 'FAIL' = 'PASS') => ({ clientId, auditRunId,
    actorUserId: userId, corpusSchemaVersion: 'discovery-proposal-backtest/1' as const, proposals: [{ proposalId, cases: [
      { caseKey: 'fuel-present', facts: { has_fuel_category: true }, expectedVerdict },
      { caseKey: 'fuel-missing', facts: {}, expectedVerdict: 'UNASSESSABLE' as const },
    ] }] });

  async function committed<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await setTenantTxScope(client, { clientIds: [clientId] });
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM discovery_rule_proposal_acceptance WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM rule_version WHERE source_discovery_rule_proposal_id=$1`, [proposalId]);
    await pool.query(`DELETE FROM rule WHERE slug=$1`, [`discovery-proposal-${proposalId}`]);
    await pool.query(`DELETE FROM discovery_rule_proposal_backtest_case WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM discovery_rule_proposal_backtest WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM discovery_rule_proposal WHERE id=$1`, [proposalId]);
    await pool.query(`DELETE FROM unknown_charge_code_trigger WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM charge_fact WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM audit_run WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM invoice WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN($1,$2)`, [clientId, otherClientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]); await pool.end();
  });

  it('backtests every proposal with immutable deterministic case evidence and exact retry behavior', async () => {
    const first = await committed((client) => backtestDiscoveryRuleProposals(client, input()));
    passingBacktestId = first.backtestIds[0]!;
    const retry = await committed((client) => backtestDiscoveryRuleProposals(client, input()));
    expect(first).toEqual({ backtestIds: retry.backtestIds, proposalCount: 1, passed: true, createdCount: 1 });
    expect(retry.createdCount).toBe(0);
    const row = (await pool.query(`SELECT * FROM discovery_rule_proposal_backtest WHERE id=$1`, [first.backtestIds[0]])).rows[0];
    expect(row).toMatchObject({ client_id: clientId, proposal_id: proposalId, corpus_schema_version: 'discovery-proposal-backtest/1',
      proposal_hash: 'd'.repeat(64), ast_hash: astHash, passed: true, pass_count: 2, regression_count: 0, actor_user_id: userId });
    const cases = (await pool.query(`SELECT case_key,expected_verdict,actual_verdict,passed,evaluated_ast FROM
      discovery_rule_proposal_backtest_case WHERE backtest_id=$1 ORDER BY case_key`, [first.backtestIds[0]])).rows;
    expect(cases.map(({ case_key, expected_verdict, actual_verdict, passed }) =>
      ({ case_key, expected_verdict, actual_verdict, passed }))).toEqual([
      { case_key: 'fuel-missing', expected_verdict: 'UNASSESSABLE', actual_verdict: 'UNASSESSABLE', passed: true },
      { case_key: 'fuel-present', expected_verdict: 'PASS', actual_verdict: 'PASS', passed: true },
    ]);
    expect(cases[1].evaluated_ast.value).toEqual({ kind: 'bool', value: true });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE client_id=$1 AND entity='discovery_rule_proposals'
      AND entity_id=$2 AND event='backtested'`, [clientId, auditRunId])).rows[0].count).toBe(1);
  });

  it('records regressions as failed evidence and never activates proposals', async () => {
    const failed = await committed((client) => backtestDiscoveryRuleProposals(client, input('FAIL')));
    expect(failed).toMatchObject({ proposalCount: 1, passed: false, createdCount: 1 });
    expect((await pool.query(`SELECT lifecycle_state FROM discovery_rule_proposal WHERE id=$1`, [proposalId])).rows[0].lifecycle_state)
      .toBe('PROPOSED');
  });

  it('routes a human-accepted proposal with a pinned passing backtest to SHADOW exactly once', async () => {
    const acceptanceInput = { clientId, proposalId, backtestId: passingBacktestId, actorUserId: userId,
      rationale: 'Reviewed citation and regression corpus.' };
    const first = await committed((client) => acceptDiscoveryRuleProposal(client, acceptanceInput));
    const retry = await committed((client) => acceptDiscoveryRuleProposal(client, acceptanceInput));
    expect(first).toEqual({ acceptanceId: retry.acceptanceId, shadowRuleVersionId: retry.shadowRuleVersionId, created: true });
    expect(retry.created).toBe(false);
    const shadow = (await pool.query(`SELECT lifecycle_state,hardness,ast_hash,source_discovery_rule_proposal_id,
      source_discovery_rule_proposal_backtest_id,provenance FROM rule_version WHERE id=$1`, [first.shadowRuleVersionId])).rows[0];
    expect(shadow).toMatchObject({ lifecycle_state: 'SHADOW', hardness: 'AI_DOCS', ast_hash: astHash,
      source_discovery_rule_proposal_id: proposalId, source_discovery_rule_proposal_backtest_id: passingBacktestId,
      provenance: { clientId, proposalId, backtestId: passingBacktestId } });
    expect((await pool.query(`SELECT count(*)::int count FROM discovery_rule_proposal_acceptance WHERE client_id=$1 AND proposal_id=$2`,
      [clientId, proposalId])).rows[0].count).toBe(1);
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE client_id=$1 AND entity_id=$2
      AND event='accepted_to_shadow'`, [clientId, proposalId])).rows[0].count).toBe(1);
  });

  it('rejects failed, foreign, and conflicting acceptance evidence without creating ACTIVE rules', async () => {
    const failedBacktest = (await pool.query(`SELECT id FROM discovery_rule_proposal_backtest WHERE proposal_id=$1 AND passed=false`,
      [proposalId])).rows[0].id;
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => acceptDiscoveryRuleProposal(client, {
      clientId, proposalId, backtestId: failedBacktest, actorUserId: userId, rationale: 'No' })))
      .rejects.toMatchObject({ code: 'PASSING_BACKTEST_REQUIRED' });
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => acceptDiscoveryRuleProposal(client, {
      clientId: otherClientId, proposalId, backtestId: passingBacktestId, actorUserId: userId, rationale: 'No' })))
      .rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' });
    expect((await pool.query(`SELECT count(*)::int count FROM rule_version WHERE source_discovery_rule_proposal_id=$1
      AND lifecycle_state='ACTIVE'`, [proposalId])).rows[0].count).toBe(0);
  });

  it('fails closed when the supplied corpus does not cover the tenant proposal set', async () => {
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => backtestDiscoveryRuleProposals(client,
      { ...input(), clientId: otherClientId }))).rejects.toMatchObject({ code: 'PROPOSAL_SET_MISMATCH' });
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => backtestDiscoveryRuleProposals(client,
      { ...input(), proposals: [{ ...input().proposals[0]!, proposalId: otherClientId }] })))
      .rejects.toBeInstanceOf(DiscoveryProposalBacktestError);
  });

  it('enforces tenant isolation and append-only application grants', async () => {
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM discovery_rule_proposal_backtest`)).rows)).toEqual([]);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE discovery_rule_proposal_backtest SET passed=false`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM discovery_rule_proposal_backtest_case`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE discovery_rule_proposal_acceptance SET rationale='x'`))).rejects.toThrow(/permission denied/i);
  });
});
