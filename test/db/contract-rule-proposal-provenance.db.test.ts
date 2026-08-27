import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { persistContractRuleProposals, ProposalPersistenceError } from '../../src/modules/contracts/persist-contract-rule-proposals.js';

describe('contract rule proposal provenance (DB)', () => {
  let pool: pg.Pool;
  const tag = `proposal-provenance-${Date.now()}`; const sourceSha = createHash('sha256').update(tag).digest('hex');
  const extractionHash = 'a'.repeat(64); const verificationHash = 'b'.repeat(64); const requestKey = 'c'.repeat(64);
  let clientId: string; let otherClientId: string; let userId: string; let carrierId: string;
  let sourceId: string; let contractId: string; let versionId: string; let verifiedId: string; let clauseId: string;
  const citation = { pageNumber: 2, excerpt: 'A fuel surcharge applies.', span: { offset: 10, length: 25 } };
  const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
  const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Proposal',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user(email) VALUES($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    sourceId = (await pool.query(`INSERT INTO source_document(client_id,sha256,content_type,byte_size,storage_uri)
      VALUES($1,$2,'application/pdf',1,$3) RETURNING id`, [clientId, sourceSha, `local://${tag}`])).rows[0].id;
    contractId = (await pool.query(`INSERT INTO contract(client_id,carrier_id,name) VALUES($1,$2,'Proposal') RETURNING id`, [clientId, carrierId])).rows[0].id;
    versionId = (await pool.query(`INSERT INTO contract_version(client_id,contract_id,valid_from,source_document_id)
      VALUES($1,$2,'2026-01-01',$3) RETURNING id`, [clientId, contractId, sourceId])).rows[0].id;
    verifiedId = (await pool.query(`INSERT INTO verified_contract_version(client_id,contract_version_id,source_document_id,
      extraction_response_hash,verification_hash,resolved_fields,verified_by) VALUES($1,$2,$3,$4,$5,'[]',$6) RETURNING id`,
    [clientId, versionId, sourceId, extractionHash, verificationHash, userId])).rows[0].id;
    clauseId = (await pool.query(`INSERT INTO contract_clause(client_id,contract_version_id,clause_ref,text_excerpt,page_ref)
      VALUES($1,$2,'4.2','A fuel surcharge applies.','2') RETURNING id`, [clientId, versionId])).rows[0].id;
    await pool.query(`INSERT INTO audit_event(client_id,entity,entity_id,event,actor_kind,detail)
      VALUES($1,'contract_extraction',$2,'persisted','ai',$3::jsonb)`, [clientId, sourceId, JSON.stringify({ responseHash: extractionHash })]);
  });

  const input = () => ({ clientId, verifiedContractVersionId: verifiedId, actorUserId: userId, result: {
    output: { schemaVersion: 'proposed-criteria/1' as const, criteria: [{ criterionKey: 'CONTRACT.PROPOSED.FUEL_PRESENT',
      kind: 'SCORING' as const, ruleType: 'CONTRACT_CONFORMANCE' as const, description: 'Fuel is present.',
      clauseReferences: ['4.2'], citations: [citation], ast, astHash, expectedInputs: ['has_fuel_category' as const], lifecycleState: 'PROPOSED' as const }] },
    provider: 'anthropic' as const, modelId: 'claude-opus-5', promptVersion: 'contract-proposed-criteria/1' as const,
    sourceDocumentSha256: sourceSha, requestKey, providerMessageId: 'msg-proposal-1', usage: { inputTokens: 10, outputTokens: 5 },
  } });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal_clause WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_rule_proposal WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_clause WHERE id=$1`, [clauseId]);
    await pool.query(`DELETE FROM verified_contract_version WHERE id=$1`, [verifiedId]);
    await pool.query(`DELETE FROM contract_version WHERE id=$1`, [versionId]); await pool.query(`DELETE FROM contract WHERE id=$1`, [contractId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceId]); await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN($1,$2)`, [clientId, otherClientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]); await pool.end();
  });

  it('persists complete proposal, extraction, verification, model, prompt, clause, and citation provenance exactly once', async () => {
    const first = await withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractRuleProposals(client, input()));
    const retry = await withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractRuleProposals(client, input()));
    expect(first).toEqual({ proposalIds: retry.proposalIds, proposalCount: 1, createdCount: 1 }); expect(retry.createdCount).toBe(0);
    const row = (await pool.query(`SELECT * FROM contract_rule_proposal WHERE id=$1`, [first.proposalIds[0]])).rows[0];
    expect(row).toMatchObject({ verified_contract_version_id: verifiedId, criterion_key: 'CONTRACT.PROPOSED.FUEL_PRESENT',
      lifecycle_state: 'PROPOSED', ast_hash: astHash, provider: 'anthropic', model_id: 'claude-opus-5',
      prompt_version: 'contract-proposed-criteria/1', provider_message_id: 'msg-proposal-1', request_key: requestKey,
      source_document_sha256: sourceSha, extraction_response_hash: extractionHash, verification_hash: verificationHash, actor_user_id: userId });
    expect((await pool.query(`SELECT contract_clause_id,citations FROM contract_rule_proposal_clause WHERE proposal_id=$1`, [first.proposalIds[0]])).rows[0])
      .toMatchObject({ contract_clause_id: clauseId, citations: [citation] });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE client_id=$1 AND entity='contract_rule_proposals'
      AND event='persisted'`, [clientId])).rows[0].count).toBe(1);
  });

  it('fails closed on tenant/source/clause/hash mismatches', async () => {
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => persistContractRuleProposals(client,
      { ...input(), clientId: otherClientId }))).rejects.toBeInstanceOf(ProposalPersistenceError);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractRuleProposals(client,
      { ...input(), result: { ...input().result, sourceDocumentSha256: 'd'.repeat(64) } }))).rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
    const bad = input(); bad.result.output.criteria[0]!.astHash = 'e'.repeat(64);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractRuleProposals(client, bad)))
      .rejects.toMatchObject({ code: 'AST_HASH_MISMATCH' });
  });

  it('is tenant isolated and append-only for the application role', async () => {
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM contract_rule_proposal`)).rows)).toEqual([]);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE contract_rule_proposal SET lifecycle_state='ACTIVE'`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM contract_rule_proposal_clause`))).rejects.toThrow(/permission denied/i);
  });
});
