import type pg from 'pg';

export interface ReviewQueueItem { id: string; auditRunId: string; invoiceNumber: string | null; criterionKey: string; createdAt: Date }
export async function listReviewQueues(client: pg.PoolClient): Promise<{ escalation: ReviewQueueItem[]; unassessable: ReviewQueueItem[] }> {
  const rows = (await client.query<{ id: string; audit_run_id: string; invoice_number: string | null; criterion_key: string; created_at: Date; classification: string | null; status: string }>(
    `SELECT vf.id, vf.audit_run_id, i.invoice_number, c.criterion_key, vf.created_at, vf.classification, vf.status::text
     FROM variance_finding vf JOIN audit_run ar ON ar.id=vf.audit_run_id JOIN invoice i ON i.id=ar.invoice_id
     JOIN criterion c ON c.id=vf.criterion_id
     WHERE vf.classification='unassessable' OR vf.status='in_review'
     ORDER BY vf.created_at, vf.id`)).rows;
  const map = (row: typeof rows[number]): ReviewQueueItem => ({ id: row.id, auditRunId: row.audit_run_id,
    invoiceNumber: row.invoice_number, criterionKey: row.criterion_key, createdAt: row.created_at });
  return { escalation: rows.filter((r) => r.status === 'in_review').map(map),
    unassessable: rows.filter((r) => r.classification === 'unassessable').map(map) };
}
