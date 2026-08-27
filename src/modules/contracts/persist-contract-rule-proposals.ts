import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { stableStringify } from '../evaluator/snapshot.js';
import { PROPOSED_CRITERIA_PROMPT_VERSION, ProposedCriteriaSchema } from './proposed-criteria.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.object({
  clientId: z.uuid(), verifiedContractVersionId: z.uuid(), actorUserId: z.uuid(),
  result: z.object({
    output: ProposedCriteriaSchema,
    provider: z.literal('anthropic'), modelId: z.string().trim().min(1).max(200),
    promptVersion: z.literal(PROPOSED_CRITERIA_PROMPT_VERSION), sourceDocumentSha256: sha,
    requestKey: sha, providerMessageId: z.string().trim().min(1).max(500),
    usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(),
  }).strict(),
}).strict();

export class ProposalPersistenceError extends Error {
  constructor(readonly code: 'VERIFIED_VERSION_NOT_FOUND' | 'SOURCE_HASH_MISMATCH' | 'EXTRACTION_NOT_FOUND' |
    'CLAUSE_NOT_FOUND' | 'AST_HASH_MISMATCH' | 'EXPECTED_INPUTS_MISMATCH' | 'PARTIAL_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'ProposalPersistenceError';
  }
}

export async function persistContractRuleProposals(client: pg.PoolClient, untrusted: z.input<typeof inputSchema>): Promise<{
  proposalIds: string[]; proposalCount: number; createdCount: number;
}> {
  const input = inputSchema.parse(untrusted);
  const verified = (await client.query<{ source_document_id: string; extraction_response_hash: string; verification_hash: string; sha256: string;
    contract_version_id: string }>(`SELECT v.source_document_id,v.extraction_response_hash,v.verification_hash,s.sha256,v.contract_version_id
    FROM verified_contract_version v JOIN source_document s ON s.id=v.source_document_id AND s.client_id=v.client_id
    WHERE v.id=$1 AND v.client_id=$2`, [input.verifiedContractVersionId, input.clientId])).rows[0];
  if (!verified) throw new ProposalPersistenceError('VERIFIED_VERSION_NOT_FOUND');
  if (verified.sha256 !== input.result.sourceDocumentSha256) throw new ProposalPersistenceError('SOURCE_HASH_MISMATCH');
  const extractionExists = (await client.query(`SELECT 1 FROM audit_event WHERE client_id=$1 AND entity='contract_extraction'
    AND entity_id=$2 AND event='persisted' AND detail->>'responseHash'=$3 LIMIT 1`,
  [input.clientId, verified.source_document_id, verified.extraction_response_hash])).rowCount;
  if (!extractionExists) throw new ProposalPersistenceError('EXTRACTION_NOT_FOUND');

  const references = [...new Set(input.result.output.criteria.flatMap((criterion) => criterion.clauseReferences))].sort();
  const clauseRows = references.length ? (await client.query<{ id: string; clause_ref: string }>(`SELECT id,clause_ref FROM contract_clause
    WHERE client_id=$1 AND contract_version_id=$2 AND clause_ref=ANY($3::text[]) ORDER BY clause_ref`,
  [input.clientId, verified.contract_version_id, references])).rows : [];
  const clauses = new Map(clauseRows.map((row) => [row.clause_ref, row.id]));
  if (references.some((reference) => !clauses.has(reference))) throw new ProposalPersistenceError('CLAUSE_NOT_FOUND');

  const proposalIds: string[] = []; let createdCount = 0;
  for (const criterion of input.result.output.criteria) {
    const astHash = createHash('sha256').update(stableStringify(criterion.ast)).digest('hex');
    if (astHash !== criterion.astHash) throw new ProposalPersistenceError('AST_HASH_MISMATCH');
    const expectedInputs = [...collectFacts(criterion.ast)].sort();
    if (stableStringify(expectedInputs) !== stableStringify(criterion.expectedInputs)) throw new ProposalPersistenceError('EXPECTED_INPUTS_MISMATCH');
    const proposalHash = createHash('sha256').update(stableStringify({ verifiedContractVersionId: input.verifiedContractVersionId,
      criterion, provider: input.result.provider, modelId: input.result.modelId, promptVersion: input.result.promptVersion,
      providerMessageId: input.result.providerMessageId, requestKey: input.result.requestKey,
      extractionResponseHash: verified.extraction_response_hash, verificationHash: verified.verification_hash })).digest('hex');
    const params = [input.clientId, input.verifiedContractVersionId, criterion.criterionKey, criterion.kind, criterion.ruleType,
      criterion.description, JSON.stringify(criterion.ast), criterion.astHash, JSON.stringify(criterion.expectedInputs),
      criterion.lifecycleState, input.result.output.schemaVersion, input.result.provider, input.result.modelId,
      input.result.promptVersion, input.result.providerMessageId, input.result.requestKey, input.result.sourceDocumentSha256,
      verified.extraction_response_hash, verified.verification_hash, proposalHash, input.actorUserId];
    const inserted = await client.query<{ id: string }>(`INSERT INTO contract_rule_proposal
      (client_id,verified_contract_version_id,criterion_key,kind,rule_type,description,ast,ast_hash,expected_inputs,
       lifecycle_state,proposal_schema_version,provider,model_id,prompt_version,provider_message_id,request_key,
       source_document_sha256,extraction_response_hash,verification_hash,proposal_hash,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT DO NOTHING RETURNING id`, params);
    let id = inserted.rows[0]?.id; if (id) createdCount += 1;
    if (!id) id = (await client.query<{ id: string }>(`SELECT id FROM contract_rule_proposal WHERE client_id=$1 AND proposal_hash=$2
      AND verified_contract_version_id=$3 AND criterion_key=$4 AND ast_hash=$5`,
    [input.clientId, proposalHash, input.verifiedContractVersionId, criterion.criterionKey, criterion.astHash])).rows[0]?.id;
    if (!id) throw new ProposalPersistenceError('PARTIAL_CONFLICT');
    proposalIds.push(id);
    for (const reference of [...criterion.clauseReferences].sort()) {
      const relation = await client.query(`INSERT INTO contract_rule_proposal_clause(client_id,proposal_id,contract_clause_id,citations)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(client_id,proposal_id,contract_clause_id) DO NOTHING`,
      [input.clientId, id, clauses.get(reference), JSON.stringify(criterion.citations)]);
      if (relation.rowCount !== 1) {
        const exact = (await client.query(`SELECT 1 FROM contract_rule_proposal_clause WHERE client_id=$1 AND proposal_id=$2
          AND contract_clause_id=$3 AND citations IS NOT DISTINCT FROM $4::jsonb`,
        [input.clientId, id, clauses.get(reference), JSON.stringify(criterion.citations)])).rowCount;
        if (!exact) throw new ProposalPersistenceError('PARTIAL_CONFLICT');
      }
    }
  }
  await writeAuditEvent(client, { id: deterministicAuditEventId(input.clientId, input.verifiedContractVersionId,
    input.result.requestKey, 'contract_rule_proposals.persisted'), clientId: input.clientId,
  entity: 'contract_rule_proposals', entityId: input.verifiedContractVersionId, event: 'persisted', actorKind: 'ai', actorUserId: input.actorUserId,
  detail: { proposalIds, proposalCount: proposalIds.length, requestKey: input.result.requestKey,
    modelId: input.result.modelId, promptVersion: input.result.promptVersion, providerMessageId: input.result.providerMessageId,
    extractionResponseHash: verified.extraction_response_hash, verificationHash: verified.verification_hash } });
  return { proposalIds, proposalCount: proposalIds.length, createdCount };
}

function collectFacts(node: unknown, keys = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return keys;
  const value = node as { type?: string; key?: string; then?: unknown; left?: unknown; right?: unknown; args?: unknown[] };
  if ((value.type === 'fact' || value.type === 'require') && value.key) keys.add(value.key);
  if (value.then) collectFacts(value.then, keys); if (value.left) collectFacts(value.left, keys); if (value.right) collectFacts(value.right, keys);
  value.args?.forEach((item) => collectFacts(item, keys)); return keys;
}
