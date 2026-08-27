import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { backtestContractRuleProposals, ProposalBacktestError } from '../../src/modules/contracts/backtest-contract-rule-proposals.js';

describe('contract proposal backtest evidence (DB)', () => {
  let pool: pg.Pool;
  const tag = `proposal-backtest-${Date.now()}`; const sha = createHash('sha256').update(tag).digest('hex');
  const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
  const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');
  let clientId: string; let otherClientId: string; let userId: string; let carrierId: string;
  let sourceId: string; let contractId: string; let versionId: string; let verifiedId: string; let proposalId: string;

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Backtest',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user(email) VALUES($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    sourceId = (await pool.query(`INSERT INTO source_document(client_id,sha256,content_type,byte_size,storage_uri)
      VALUES($1,$2,'application/pdf',1,$3) RETURNING id`, [clientId, sha, `local://${tag}`])).rows[0].id;
    contractId = (await pool.query(`INSERT INTO contract(client_id,carrier_id,name) VALUES($1,$2,'Backtest') RETURNING id`,
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
  });

  const input = (expectedVerdict: 'PASS' | 'FAIL' = 'PASS') => ({ clientId, verifiedContractVersionId: verifiedId,
    actorUserId: userId, corpusSchemaVersion: 'contract-proposal-backtest/1' as const, proposals: [{ proposalId, cases: [
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
    await pool.query(`DELETE FROM contract_rule_proposal_backtest_case WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal_backtest WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal WHERE id=$1`, [proposalId]);
    await pool.query(`DELETE FROM verified_contract_version WHERE id=$1`, [verifiedId]);
    await pool.query(`DELETE FROM contract_version WHERE id=$1`, [versionId]); await pool.query(`DELETE FROM contract WHERE id=$1`, [contractId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceId]); await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN($1,$2)`, [clientId, otherClientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]); await pool.end();
  });

  it('backtests every proposal with immutable deterministic case evidence and exact retry behavior', async () => {
    const first = await committed((client) => backtestContractRuleProposals(client, input()));
    const retry = await committed((client) => backtestContractRuleProposals(client, input()));
    expect(first).toEqual({ backtestIds: retry.backtestIds, proposalCount: 1, passed: true, createdCount: 1 });
    expect(retry.createdCount).toBe(0);
    const row = (await pool.query(`SELECT * FROM contract_rule_proposal_backtest WHERE id=$1`, [first.backtestIds[0]])).rows[0];
    expect(row).toMatchObject({ client_id: clientId, proposal_id: proposalId, corpus_schema_version: 'contract-proposal-backtest/1',
      proposal_hash: 'd'.repeat(64), ast_hash: astHash, passed: true, pass_count: 2, regression_count: 0, actor_user_id: userId });
    const cases = (await pool.query(`SELECT case_key,expected_verdict,actual_verdict,passed,evaluated_ast FROM
      contract_rule_proposal_backtest_case WHERE backtest_id=$1 ORDER BY case_key`, [first.backtestIds[0]])).rows;
    expect(cases.map(({ case_key, expected_verdict, actual_verdict, passed }) =>
      ({ case_key, expected_verdict, actual_verdict, passed }))).toEqual([
      { case_key: 'fuel-missing', expected_verdict: 'UNASSESSABLE', actual_verdict: 'UNASSESSABLE', passed: true },
      { case_key: 'fuel-present', expected_verdict: 'PASS', actual_verdict: 'PASS', passed: true },
    ]);
    expect(cases[1].evaluated_ast.value).toEqual({ kind: 'bool', value: true });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE client_id=$1 AND entity='contract_rule_proposals'
      AND entity_id=$2 AND event='backtested'`, [clientId, verifiedId])).rows[0].count).toBe(1);
  });

  it('records regressions as failed evidence and never activates proposals', async () => {
    const failed = await committed((client) => backtestContractRuleProposals(client, input('FAIL')));
    expect(failed).toMatchObject({ proposalCount: 1, passed: false, createdCount: 1 });
    expect((await pool.query(`SELECT lifecycle_state FROM contract_rule_proposal WHERE id=$1`, [proposalId])).rows[0].lifecycle_state)
      .toBe('PROPOSED');
  });

  it('fails closed when the supplied corpus does not cover the tenant proposal set', async () => {
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => backtestContractRuleProposals(client,
      { ...input(), clientId: otherClientId }))).rejects.toMatchObject({ code: 'PROPOSAL_SET_MISMATCH' });
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => backtestContractRuleProposals(client,
      { ...input(), proposals: [{ ...input().proposals[0]!, proposalId: otherClientId }] })))
      .rejects.toBeInstanceOf(ProposalBacktestError);
  });

  it('enforces tenant isolation and append-only application grants', async () => {
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM contract_rule_proposal_backtest`)).rows)).toEqual([]);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE contract_rule_proposal_backtest SET passed=false`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM contract_rule_proposal_backtest_case`))).rejects.toThrow(/permission denied/i);
  });
});
