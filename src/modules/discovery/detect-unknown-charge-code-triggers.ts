import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({ clientId: z.uuid(), auditRunId: z.uuid() }).strict();

export class DiscoveryTriggerError extends Error {
  constructor(readonly code: 'AUDIT_RUN_NOT_FOUND' | 'TRIGGER_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'DiscoveryTriggerError';
  }
}

interface UnresolvedCharge { id: string; code: string | null; raw_description: string | null }

/**
 * Detects charge_fact rows on the invoice behind this audit_run whose
 * charge-code crosswalk lookup produced no canonical category (category IS
 * NULL) -- e.g. a code the crosswalk has never seen. Idempotent: re-running
 * against the same audit_run never inserts a duplicate trigger for the same
 * charge_fact_id (UNIQUE(client_id, charge_fact_id) from 0045).
 */
export async function detectUnknownChargeCodeTriggers(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const input = schema.parse(untrusted);
  const run = await client.query<{ invoice_id: string }>(
    `SELECT invoice_id FROM audit_run WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.auditRunId],
  );
  if (!run.rowCount) throw new DiscoveryTriggerError('AUDIT_RUN_NOT_FOUND');
  const invoiceId = run.rows[0]!.invoice_id;

  const { rows } = await client.query<UnresolvedCharge>(
    `SELECT id, code, raw_description FROM charge_fact
      WHERE client_id = $1 AND invoice_id = $2 AND category IS NULL
      ORDER BY id`,
    [input.clientId, invoiceId],
  );

  const ids: string[] = [];
  let createdCount = 0;
  for (const row of rows) {
    const detail = { code: row.code, rawDescription: row.raw_description };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO discovery_trigger
         (client_id, trigger_type, source_kind, charge_fact_id, detail)
       VALUES ($1,'UNKNOWN_CHARGE_CODE','CHARGE_FACT',$2,$3::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [input.clientId, row.id, JSON.stringify(detail)],
    );
    let id = inserted.rows[0]?.id;
    if (id) createdCount++;
    if (!id) {
      id = (
        await client.query<{ id: string }>(
          `SELECT id FROM discovery_trigger WHERE client_id = $1 AND charge_fact_id = $2`,
          [input.clientId, row.id],
        )
      ).rows[0]?.id;
    }
    if (!id) throw new DiscoveryTriggerError('TRIGGER_CONFLICT');
    ids.push(id);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.auditRunId, 'unknown-charge-code-discovery'),
    clientId: input.clientId,
    entity: 'discovery_trigger',
    entityId: input.auditRunId,
    event: 'unknown_charge_code_detected',
    actorKind: 'system',
    detail: { triggerIds: ids, triggerCount: ids.length },
  });
  return { triggerIds: ids, createdCount };
}
