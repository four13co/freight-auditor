import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { seedCriteria } from '../../scripts/seed-criteria.mjs';
import { resolveClaim, ResolveClaimError } from '../../src/modules/claims/resolve-claim.js';
import { ClaimResolutionError } from '../../src/modules/claims/validate-claim-resolution.js';

/**
 * 86e2zfj5k: resolving a claim to a terminal outcome (P5.A.4).
 */
describe('resolveClaim (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `rc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    await seedCriteria({ client: pool });
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('RC-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('RC-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM finding_status_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; amountClaimed?: string }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, $2, 'USD', 'open') RETURNING id`,
      [opts.clientId, opts.amountClaimed ?? '500.0000'],
    );
    return rows[0]!.id;
  }

  async function seedFinding(client: pg.PoolClient, opts: { clientId: string }): Promise<string> {
    const inv = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, transaction_set, parser_version) VALUES ($1, '210', 'test') RETURNING id`,
      [opts.clientId],
    );
    const run = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [opts.clientId, inv.rows[0]!.id],
    );
    const vf = await client.query<{ id: string }>(
      `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, status, evaluated_expr)
       SELECT $1, $2, c.id, rv.id, 'open', '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [opts.clientId, run.rows[0]!.id],
    );
    return vf.rows[0]!.id;
  }

  it('resolves a claim to recovered with a matching full-amount recovery event', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'FULL_RECOVERY', amountRecovered: '500.0000', currency: 'USD' });
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('recovered');
    expect(row.result.recoveryEventId).not.toBeNull();
    expect(row.status).toBe('recovered');
  });

  it('resolves a claim to denied with no recovery event written', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'DENIAL' });
      const events = await client.query(`SELECT id FROM recovery_event WHERE claim_id = $1`, [claimId]);
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, eventCount: events.rows.length, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('denied');
    expect(row.result.recoveryEventId).toBeNull();
    expect(row.eventCount).toBe(0);
    expect(row.status).toBe('denied');
  });

  it('resolves a claim to written_off with a partial recovery already recorded', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await client.query(
        `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD')`,
        [clientAId, claimId],
      );
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF' });
      const status = await client.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { result, status: status.rows[0].status };
    });

    expect(row.result.newStatus).toBe('written_off');
    expect(row.result.recoveryEventId).toBeNull();
    expect(row.status).toBe('written_off');
  });

  it('rejects resolving a claim that is already terminal', async () => {
    await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      await resolveClaim(client, { clientId: clientAId, claimId, kind: 'DENIAL' });
      await expect(resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF' }))
        .rejects.toBeInstanceOf(ClaimResolutionError);
    });
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        resolveClaim(client, { clientId: clientBId, claimId, kind: 'DENIAL' }),
      ),
    ).rejects.toBeInstanceOf(ResolveClaimError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        resolveClaim(client, { clientId: clientAId, claimId: '00000000-0000-0000-0000-000000000000', kind: 'DENIAL' }),
      ),
    ).rejects.toBeInstanceOf(ResolveClaimError);
  });

  it('transitions the linked variance_finding to recovered when its claim resolves to FULL_RECOVERY (86e32tg56)', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const findingId = await seedFinding(client, { clientId: clientAId });
      const result = await resolveClaim(client, {
        clientId: clientAId, claimId, kind: 'FULL_RECOVERY', amountRecovered: '500.0000', currency: 'USD', varianceFindingId: findingId,
      });
      const finding = await client.query(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
      return { result, findingStatus: finding.rows[0].status };
    });

    expect(row.result.newStatus).toBe('recovered');
    expect(row.findingStatus).toBe('recovered');
  });

  it('transitions the linked variance_finding to written_off when its claim resolves to WRITE_OFF', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const findingId = await seedFinding(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF', varianceFindingId: findingId });
      const finding = await client.query(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
      return { result, findingStatus: finding.rows[0].status };
    });

    expect(row.result.newStatus).toBe('written_off');
    expect(row.findingStatus).toBe('written_off');
  });

  it('leaves an unnamed variance_finding untouched -- resolving without varianceFindingId does not guess', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const findingId = await seedFinding(client, { clientId: clientAId });
      await resolveClaim(client, { clientId: clientAId, claimId, kind: 'WRITE_OFF' });
      const finding = await client.query(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
      return finding.rows[0].status;
    });

    expect(row).toBe('open');
  });

  it('leaves the linked variance_finding untouched on DENIAL -- denied is not a variance_status value', async () => {
    const row = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const findingId = await seedFinding(client, { clientId: clientAId });
      const result = await resolveClaim(client, { clientId: clientAId, claimId, kind: 'DENIAL', varianceFindingId: findingId });
      const finding = await client.query(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
      return { result, findingStatus: finding.rows[0].status };
    });

    expect(row.result.newStatus).toBe('denied');
    expect(row.findingStatus).toBe('open');
  });
});
