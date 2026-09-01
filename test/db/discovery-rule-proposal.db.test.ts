import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { listDiscoveryEvidence, persistDiscoveryRuleProposals, DiscoveryRuleProposalError } from '../../src/modules/discovery/discovery-rule-proposal.js';

describe('discovery rule proposals (DB)', () => {
  let pool: pg.Pool;
  const tag = `discovery-proposal-${Date.now()}`;
  let clientId: string; let otherClientId: string; let carrierId: string;
  let auditRunId: string; let invoiceId: string; let chargeFactId: string; let unknownCodeTriggerId: string; let coverageMarkerId: string; let suspiciousPassTriggerId: string;

  const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
  const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Discovery',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    invoiceId = (await pool.query(`INSERT INTO invoice(client_id,carrier_id,transaction_set,invoice_number,currency,parser_version)
      VALUES($1,$2,'210',$3,'USD','test') RETURNING id`, [clientId, carrierId, `INV-${tag}`])).rows[0].id;
    auditRunId = (await pool.query(`INSERT INTO audit_run(client_id,invoice_id,engine_spec_version,outcome)
      VALUES($1,$2,'test','DISCOVERY_PENDING') RETURNING id`, [clientId, invoiceId])).rows[0].id;
    chargeFactId = (await pool.query(`INSERT INTO charge_fact(client_id,invoice_id,code,x12_element,amount,currency)
      VALUES($1,$2,'ZZZ','C302-02',10,'USD') RETURNING id`, [clientId, invoiceId])).rows[0].id;
    unknownCodeTriggerId = (await pool.query(`INSERT INTO unknown_charge_code_trigger(client_id,audit_run_id,charge_fact_id,source_code,x12_element,detail)
      VALUES($1,$2,$3,'ZZZ','C302-02','{}'::jsonb) RETURNING id`, [clientId, auditRunId, chargeFactId])).rows[0].id;
    coverageMarkerId = (await pool.query(`INSERT INTO coverage_marker(client_id,audit_run_id,charge_index,marker_code,missing_fields)
      VALUES($1,$2,0,'INCOMPLETE_RATE_BASIS',ARRAY['basis']) RETURNING id`, [clientId, auditRunId])).rows[0].id;
    suspiciousPassTriggerId = (await pool.query(`INSERT INTO suspicious_pass_trigger(client_id,audit_run_id,coverage_marker_id,marker_code,detail)
      VALUES($1,$2,$3,'INCOMPLETE_RATE_BASIS','{}'::jsonb) RETURNING id`, [clientId, auditRunId, coverageMarkerId])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM discovery_rule_proposal WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM suspicious_pass_trigger WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM coverage_marker WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM unknown_charge_code_trigger WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM charge_fact WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM audit_run WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM invoice WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]);
    await pool.query(`DELETE FROM client WHERE id IN($1,$2)`, [clientId, otherClientId]);
    await pool.end();
  });

  async function withCommittedTenant<T>(ids: string[], fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await setTenantTxScope(client, { clientIds: ids });
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  const resultFor = (citedTriggerId: string, providerMessageId: string) => ({
    output: { schemaVersion: 'discovery-rule-proposal/1' as const, criteria: [{
      criterionKey: 'DISCOVERY.PROPOSED.UNKNOWN_CODE_ZZZ', kind: 'SCORING' as const, ruleType: 'EXTERNAL_REFERENCE' as const,
      description: 'Charge code ZZZ should resolve to a known category.', citedTriggerId, ast, astHash,
      expectedInputs: ['has_fuel_category' as const], lifecycleState: 'PROPOSED' as const }] },
    provider: 'anthropic' as const, modelId: 'claude-opus-5', promptVersion: 'discovery-rule-proposal/1' as const,
    // Each distinct generation attempt (a distinct providerMessageId) gets its own
    // requestKey -- writeAuditEvent's deterministic id is keyed on requestKey, and
    // reusing one across two DIFFERENT generation requests would collide as
    // "different immutable evidence" for the same audit event id.
    requestKey: createHash('sha256').update(`${tag}-${providerMessageId}`).digest('hex'),
    providerMessageId, usage: { inputTokens: 10, outputTokens: 5 },
  });

  it('lists evidence across all three trigger tables and excludes already-proposed triggers', async () => {
    const evidence = await withAppTx(pool, { clientIds: [clientId] },
      (client) => listDiscoveryEvidence(client, { clientId, auditRunId }));
    expect(evidence).toEqual(expect.arrayContaining([
      { triggerKind: 'UNKNOWN_CHARGE_CODE', triggerId: unknownCodeTriggerId, detail: {} },
      { triggerKind: 'SUSPICIOUS_PASS', triggerId: suspiciousPassTriggerId, detail: {} },
    ]));
    expect(evidence).toHaveLength(2);

    await withCommittedTenant([clientId], (client) =>
      persistDiscoveryRuleProposals(client, { clientId, auditRunId, result: resultFor(unknownCodeTriggerId, 'msg-list-1') }));

    const remaining = await withAppTx(pool, { clientIds: [clientId] },
      (client) => listDiscoveryEvidence(client, { clientId, auditRunId }));
    expect(remaining).toEqual([{ triggerKind: 'SUSPICIOUS_PASS', triggerId: suspiciousPassTriggerId, detail: {} }]);
  });

  it('persists a proposal exactly once across retries and resolves the correct trigger column', async () => {
    const first = await withCommittedTenant([clientId],
      (client) => persistDiscoveryRuleProposals(client, { clientId, auditRunId, result: resultFor(suspiciousPassTriggerId, 'msg-persist-1') }));
    const retry = await withCommittedTenant([clientId],
      (client) => persistDiscoveryRuleProposals(client, { clientId, auditRunId, result: resultFor(suspiciousPassTriggerId, 'msg-persist-1') }));
    expect(first).toEqual({ proposalIds: retry.proposalIds, proposalCount: 1, createdCount: 1 });
    expect(retry.createdCount).toBe(0);
    const row = (await pool.query(`SELECT * FROM discovery_rule_proposal WHERE id=$1`, [first.proposalIds[0]])).rows[0];
    expect(row).toMatchObject({ audit_run_id: auditRunId, suspicious_pass_trigger_id: suspiciousPassTriggerId,
      discovery_trigger_id: null, unknown_charge_code_trigger_id: null, lifecycle_state: 'PROPOSED',
      criterion_key: 'DISCOVERY.PROPOSED.UNKNOWN_CODE_ZZZ', ast_hash: astHash, actor_user_id: null });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE client_id=$1 AND entity='discovery_rule_proposals'
      AND event='persisted' AND detail->>'providerMessageId'='msg-persist-1'`, [clientId])).rows[0].count).toBe(1);
  });

  it('fails closed when the cited trigger does not exist for this client/audit run', async () => {
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistDiscoveryRuleProposals(client,
      { clientId, auditRunId, result: resultFor('ffffffff-ffff-4fff-8fff-ffffffffffff', 'msg-missing') })))
      .rejects.toBeInstanceOf(DiscoveryRuleProposalError);
  });

  it('is tenant isolated and append-only for the application role', async () => {
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM discovery_rule_proposal`)).rows)).toEqual([]);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE discovery_rule_proposal SET lifecycle_state='ACTIVE'`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM discovery_rule_proposal`))).rejects.toThrow(/permission denied/i);
  });
});
