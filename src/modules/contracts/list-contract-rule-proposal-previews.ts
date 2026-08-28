import type pg from 'pg';

export interface ContractRuleProposalPreview {
  id: string; verifiedContractVersionId: string; contractName: string; criterionKey: string; ruleType: string;
  description: string; ast: unknown; astHash: string; expectedInputs: string[]; lifecycleState: 'PROPOSED';
  modelId: string; promptVersion: string; sourceDocumentSha256: string; extractionResponseHash: string;
  verificationHash: string; recordedAt: string;
  clauses: Array<{ clauseId: string; clauseRef: string; textExcerpt: string | null; pageRef: string | null; citations: unknown[] }>;
  backtest: { id: string; passed: boolean; passCount: number; regressionCount: number; corpusHash: string; recordedAt: string } | null;
  baseline: { ast: unknown; astHash: string; description: string | null } | null;
  acceptance: { id: string; shadowRuleVersionId: string; acceptedBy: string; rationale: string; recordedAt: string } | null;
  diff: { status: 'NEW' | 'UNCHANGED' | 'CHANGED'; astChanged: boolean; descriptionChanged: boolean };
}

interface PreviewRow {
  id: string; verified_contract_version_id: string; contract_name: string; criterion_key: string; rule_type: string;
  description: string; ast: unknown; ast_hash: string; expected_inputs: string[]; lifecycle_state: 'PROPOSED';
  model_id: string; prompt_version: string; source_document_sha256: string; extraction_response_hash: string;
  verification_hash: string; recorded_at: Date | string; clauses: ContractRuleProposalPreview['clauses'];
  backtest_id: string | null; backtest_passed: boolean | null; pass_count: number | null; regression_count: number | null;
  corpus_hash: string | null; backtest_recorded_at: Date | string | null;
  baseline_ast: unknown | null; baseline_ast_hash: string | null; baseline_description: string | null;
  acceptance_id: string | null; shadow_rule_version_id: string | null; accepted_by: string | null;
  acceptance_rationale: string | null; acceptance_recorded_at: Date | string | null;
}

export async function listContractRuleProposalPreviews(client: pg.PoolClient): Promise<ContractRuleProposalPreview[]> {
  const rows = (await client.query<PreviewRow>(`SELECT p.id,p.verified_contract_version_id,c.name AS contract_name,
    p.criterion_key,p.rule_type,p.description,p.ast,p.ast_hash,p.expected_inputs,p.lifecycle_state,p.model_id,p.prompt_version,
    p.source_document_sha256,p.extraction_response_hash,p.verification_hash,p.recorded_at,
    COALESCE(cl.clauses,'[]'::jsonb) AS clauses,bt.id AS backtest_id,bt.passed AS backtest_passed,
    bt.pass_count,bt.regression_count,bt.corpus_hash,bt.recorded_at AS backtest_recorded_at,
    base.ast AS baseline_ast,base.ast_hash AS baseline_ast_hash,base.description AS baseline_description,
    acc.id AS acceptance_id,acc.shadow_rule_version_id,acc.accepted_by,acc.rationale AS acceptance_rationale,
    acc.recorded_at AS acceptance_recorded_at
    FROM contract_rule_proposal p
    JOIN verified_contract_version vv ON vv.id=p.verified_contract_version_id AND vv.client_id=p.client_id
    JOIN contract_version cv ON cv.id=vv.contract_version_id AND cv.client_id=p.client_id
    JOIN contract c ON c.id=cv.contract_id AND c.client_id=p.client_id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('clauseId',cc.id,'clauseRef',cc.clause_ref,
      'textExcerpt',cc.text_excerpt,'pageRef',cc.page_ref,'citations',pc.citations) ORDER BY cc.clause_ref,cc.id) AS clauses
      FROM contract_rule_proposal_clause pc JOIN contract_clause cc ON cc.id=pc.contract_clause_id AND cc.client_id=pc.client_id
      WHERE pc.client_id=p.client_id AND pc.proposal_id=p.id) cl ON true
    LEFT JOIN LATERAL (SELECT b.id,b.passed,b.pass_count,b.regression_count,b.corpus_hash,b.recorded_at
      FROM contract_rule_proposal_backtest b WHERE b.client_id=p.client_id AND b.proposal_id=p.id
      ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) bt ON true
    LEFT JOIN LATERAL (SELECT rv.ast,rv.ast_hash,cvb.description FROM criterion cb
      JOIN criterion_version cvb ON cvb.criterion_id=cb.id
      JOIN criterion_rule cr ON cr.criterion_version_id=cvb.id
      JOIN rule_version rv ON rv.rule_id=cr.rule_id AND rv.lifecycle_state='ACTIVE'
      WHERE cb.criterion_key=p.criterion_key
      ORDER BY cvb.recorded_at DESC,cr.rank,rv.recorded_at DESC LIMIT 1) base ON true
    LEFT JOIN contract_rule_proposal_acceptance acc ON acc.client_id=p.client_id AND acc.proposal_id=p.id
    ORDER BY p.recorded_at,p.id`)).rows;
  return rows.map((row) => {
    const astChanged = row.baseline_ast_hash !== null && row.baseline_ast_hash !== row.ast_hash;
    const descriptionChanged = row.baseline_ast_hash !== null && row.baseline_description !== row.description;
    return { id: row.id, verifiedContractVersionId: row.verified_contract_version_id, contractName: row.contract_name,
      criterionKey: row.criterion_key, ruleType: row.rule_type, description: row.description, ast: row.ast, astHash: row.ast_hash,
      expectedInputs: row.expected_inputs, lifecycleState: row.lifecycle_state, modelId: row.model_id,
      promptVersion: row.prompt_version, sourceDocumentSha256: row.source_document_sha256,
      extractionResponseHash: row.extraction_response_hash, verificationHash: row.verification_hash,
      recordedAt: new Date(row.recorded_at).toISOString(), clauses: row.clauses,
      backtest: row.backtest_id === null ? null : { id: row.backtest_id, passed: row.backtest_passed!,
        passCount: row.pass_count!, regressionCount: row.regression_count!, corpusHash: row.corpus_hash!,
        recordedAt: new Date(row.backtest_recorded_at!).toISOString() },
      baseline: row.baseline_ast_hash === null ? null : { ast: row.baseline_ast, astHash: row.baseline_ast_hash,
        description: row.baseline_description },
      acceptance: row.acceptance_id === null ? null : { id: row.acceptance_id, shadowRuleVersionId: row.shadow_rule_version_id!,
        acceptedBy: row.accepted_by!, rationale: row.acceptance_rationale!,
        recordedAt: new Date(row.acceptance_recorded_at!).toISOString() },
      diff: { status: row.baseline_ast_hash === null ? 'NEW' : astChanged || descriptionChanged ? 'CHANGED' : 'UNCHANGED',
        astChanged, descriptionChanged } };
  });
}
