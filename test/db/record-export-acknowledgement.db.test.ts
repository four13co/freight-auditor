import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { StandInExportAdapter } from '../../src/modules/exports/stand-in-export-adapter.js';
import {
  recordExportAcknowledgement,
  RecordExportAcknowledgementError,
  type SettledExportResult,
} from '../../src/modules/exports/record-export-acknowledgement.js';

/**
 * 86e2zfhev (P4.B.9): persisting the outcome of a P4.B.8 ExportAdapter
 * attempt into the append-only export_acknowledgement table (0075).
 */
describe('recordExportAcknowledgement (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `xack-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('XACK-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('XACK-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM export_acknowledgement WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, clientId: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', 'open') RETURNING id`,
      [clientId],
    );
    return rows[0]!.id;
  }

  async function seedPaymentGateDecision(client: pg.PoolClient, clientId: string): Promise<string> {
    const inv = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, '210', $2, 'USD', 'test') RETURNING id`,
      [clientId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payment_gate_decision (client_id, invoice_id, action, actor_kind, rationale)
       VALUES ($1, $2, 'hold', 'system', 'test') RETURNING id`,
      [clientId, inv.rows[0]!.id],
    );
    return rows[0]!.id;
  }

  it('records an ACKNOWLEDGED reconciliation record linking to the originating claim', async () => {
    const outcome = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, clientAId);
      const adapter = new StandInExportAdapter('TESTERP');
      const result = (await adapter.export(client, {
        systemCode: 'TESTERP',
        dedupeKey: `dk-${tag}-ack`,
        payload: {},
      })) as SettledExportResult;

      const recorded = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey: `dk-${tag}-ack` },
        result,
      });

      const rows = await client.query(
        `SELECT status, claim_id, external_reference, reason FROM export_acknowledgement WHERE id = $1`,
        [recorded.id],
      );
      return { recorded, row: rows.rows[0] };
    });

    expect(outcome.recorded.created).toBe(true);
    expect(outcome.row.status).toBe('ACKNOWLEDGED');
    expect(outcome.row.claim_id).toBeTruthy();
    expect(outcome.row.external_reference).toBeTruthy();
    expect(outcome.row.reason).toBeNull();
  });

  it('records a FAILED reconciliation record with its reason, remaining queryable', async () => {
    const outcome = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, clientAId);
      const adapter = new StandInExportAdapter('TESTERP');
      const result = (await adapter.export(client, {
        systemCode: 'TESTERP',
        dedupeKey: `dk-${tag}-fail`,
        payload: { simulateFailure: true },
      })) as SettledExportResult;

      const recorded = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey: `dk-${tag}-fail` },
        result,
      });

      const rows = await client.query(
        `SELECT status, reason, external_reference FROM export_acknowledgement WHERE id = $1`,
        [recorded.id],
      );
      return { recorded, row: rows.rows[0] };
    });

    expect(outcome.recorded.created).toBe(true);
    expect(outcome.row.status).toBe('FAILED');
    expect(outcome.row.reason).toBe('SIMULATED_FAILURE');
    expect(outcome.row.external_reference).toBeNull();
  });

  it('does not create a second ACKNOWLEDGED row for a duplicate export attempt (idempotent on dedupe key)', async () => {
    const outcome = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, clientAId);
      const dedupeKey = `dk-${tag}-dup`;
      const adapter = new StandInExportAdapter('TESTERP');

      const first = await adapter.export(client, { systemCode: 'TESTERP', dedupeKey, payload: {} }) as SettledExportResult;
      const firstRecorded = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey },
        result: first,
      });

      // A second attempt at the same export (e.g. a retried delivery) returns the
      // same ExportResult from the stand-in adapter's own idempotency cache; the
      // persistence layer must independently be idempotent too, not merely rely
      // on the adapter returning the same value.
      const second = await adapter.export(client, { systemCode: 'TESTERP', dedupeKey, payload: {} }) as SettledExportResult;
      const secondRecorded = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey },
        result: second,
      });

      const rows = await client.query(
        `SELECT id FROM export_acknowledgement WHERE client_id = $1 AND dedupe_key = $2 AND status = 'ACKNOWLEDGED'`,
        [clientAId, dedupeKey],
      );
      return { firstRecorded, secondRecorded, count: rows.rows.length };
    });

    expect(outcome.count).toBe(1);
    expect(outcome.secondRecorded.created).toBe(false);
    expect(outcome.secondRecorded.id).toBe(outcome.firstRecorded.id);
  });

  it('allows a FAILED retry to record a second row for the same dedupe key (not deduped)', async () => {
    const outcome = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, clientAId);
      const dedupeKey = `dk-${tag}-retry`;
      const failedResult: SettledExportResult = { status: 'FAILED', reason: 'TIMEOUT', adapterVersion: 'manual-v1' };

      const first = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey },
        result: failedResult,
      });
      const second = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        claimId,
        record: { systemCode: 'TESTERP', dedupeKey },
        result: { ...failedResult, reason: 'TIMEOUT_RETRY' },
      });

      const rows = await client.query(
        `SELECT id FROM export_acknowledgement WHERE client_id = $1 AND dedupe_key = $2 AND status = 'FAILED'`,
        [clientAId, dedupeKey],
      );
      return { first, second, count: rows.rows.length };
    });

    expect(outcome.count).toBe(2);
    expect(outcome.first.created).toBe(true);
    expect(outcome.second.created).toBe(true);
    expect(outcome.first.id).not.toBe(outcome.second.id);
  });

  it('links to a payment_gate_decision when no claim is given', async () => {
    const outcome = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const paymentGateDecisionId = await seedPaymentGateDecision(client, clientAId);
      const result: SettledExportResult = { status: 'ACKNOWLEDGED', externalReference: 'ext-1', adapterVersion: 'manual-v1' };

      const recorded = await recordExportAcknowledgement(client, {
        clientId: clientAId,
        paymentGateDecisionId,
        record: { systemCode: 'TESTERP', dedupeKey: `dk-${tag}-pgd` },
        result,
      });

      const rows = await client.query(
        `SELECT payment_gate_decision_id, claim_id FROM export_acknowledgement WHERE id = $1`,
        [recorded.id],
      );
      return rows.rows[0];
    });

    expect(outcome.payment_gate_decision_id).toBeTruthy();
    expect(outcome.claim_id).toBeNull();
  });

  it('rejects when neither claimId nor paymentGateDecisionId is given', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        recordExportAcknowledgement(client, {
          clientId: clientAId,
          record: { systemCode: 'TESTERP', dedupeKey: `dk-${tag}-missing` },
          result: { status: 'ACKNOWLEDGED', externalReference: 'ext-x', adapterVersion: 'manual-v1' },
        }),
      ),
    ).rejects.toBeInstanceOf(RecordExportAcknowledgementError);
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, clientAId));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        recordExportAcknowledgement(client, {
          clientId: clientBId,
          claimId,
          record: { systemCode: 'TESTERP', dedupeKey: `dk-${tag}-xtenant` },
          result: { status: 'ACKNOWLEDGED', externalReference: 'ext-y', adapterVersion: 'manual-v1' },
        }),
      ),
    ).rejects.toBeInstanceOf(RecordExportAcknowledgementError);
  });
});
