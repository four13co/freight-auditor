import type pg from 'pg';

export interface DefensibilityChain {
  finding: { id: string; auditRunId: string; classification: string | null; varianceAmount: string | null; currency: string | null };
  criterion: { id: string; key: string };
  ruleVersion: { id: string; astHash: string };
  clause: { id: string; reference: string; page: string | null } | null;
  rateCell: { id: string; reference: string } | null;
  sourceDocument: { id: string; sha256: string; storageUri: string } | null;
  transportDocument: { id: string; number: string; type: string; sourceDocumentId: string | null } | null;
  contributors: { billedChargeFactIds: string[]; expectedChargeIds: string[] };
}

export async function getDefensibilityChain(
  client: pg.PoolClient, clientId: string, findingId: string,
): Promise<DefensibilityChain | null> {
  const result = await client.query<{
    id: string; audit_run_id: string; classification: string | null; variance_amount: string | null; currency: string | null;
    criterion_id: string; criterion_key: string; rule_version_id: string; ast_hash: string; alignment_id: string | null;
    clause_id: string | null; clause_ref: string | null; page_ref: string | null;
    rate_cell_id: string | null; cell_ref: string | null; source_document_id: string | null;
    sha256: string | null; storage_uri: string | null; transport_document_id: string | null;
    document_number: string | null; document_type: string | null; transport_source_document_id: string | null;
  }>(`SELECT vf.id, vf.audit_run_id, vf.classification, vf.variance_amount, vf.currency, vf.alignment_id,
      c.id criterion_id, c.criterion_key, rv.id rule_version_id, rv.ast_hash,
      cc.id clause_id, cc.clause_ref, cc.page_ref, rc.id rate_cell_id, rc.cell_ref,
      sd.id source_document_id, sd.sha256, sd.storage_uri,
      td.id transport_document_id, td.document_number, td.document_type::text,
      td.source_document_id transport_source_document_id
    FROM variance_finding vf
    JOIN criterion c ON c.id = vf.criterion_id
    JOIN rule_version rv ON rv.id = vf.rule_version_id
    LEFT JOIN contract_clause cc ON cc.id = vf.clause_id
    LEFT JOIN rate_cell rc ON rc.id = vf.rate_cell_id
    LEFT JOIN source_document sd ON sd.id = vf.source_document_id
    LEFT JOIN transport_document td ON td.id = vf.transport_document_id
    WHERE vf.id = $1 AND vf.client_id = $2`, [findingId, clientId]);
  const row = result.rows[0];
  if (!row) return null;
  const members = row.alignment_id ? await client.query<{ charge_fact_id: string | null; expected_charge_id: string | null }>(
    `SELECT charge_fact_id, expected_charge_id FROM charge_alignment_member
     WHERE alignment_id = $1 AND client_id = $2 ORDER BY coalesce(charge_fact_id::text, expected_charge_id::text)`,
    [row.alignment_id, clientId]) : { rows: [] };
  return {
    finding: { id: row.id, auditRunId: row.audit_run_id, classification: row.classification, varianceAmount: row.variance_amount, currency: row.currency },
    criterion: { id: row.criterion_id, key: row.criterion_key }, ruleVersion: { id: row.rule_version_id, astHash: row.ast_hash },
    clause: row.clause_id ? { id: row.clause_id, reference: row.clause_ref!, page: row.page_ref } : null,
    rateCell: row.rate_cell_id ? { id: row.rate_cell_id, reference: row.cell_ref! } : null,
    sourceDocument: row.source_document_id ? { id: row.source_document_id, sha256: row.sha256!, storageUri: row.storage_uri! } : null,
    transportDocument: row.transport_document_id ? { id: row.transport_document_id, number: row.document_number!, type: row.document_type!, sourceDocumentId: row.transport_source_document_id } : null,
    contributors: { billedChargeFactIds: members.rows.flatMap((m) => m.charge_fact_id ? [m.charge_fact_id] : []),
      expectedChargeIds: members.rows.flatMap((m) => m.expected_charge_id ? [m.expected_charge_id] : []) },
  };
}
