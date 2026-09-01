import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  requestReconciliationExport,
  getReconciliationExport,
  claimDueReconciliationExports,
  completeReconciliationExport,
  failReconciliationExport,
} from '../../src/modules/claims/reconciliation-export.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('reconciliation-export (database)', () => {
  const tag = `reconciliation-export-${Date.now()}`;
  let clientId: string;
  let otherClientId: string;

  afterEach(async () => {
    if (clientId) await getPool().query(`DELETE FROM reconciliation_export WHERE client_id = $1`, [clientId]);
    if (otherClientId) await getPool().query(`DELETE FROM reconciliation_export WHERE client_id = $1`, [otherClientId]);
    if (clientId) await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    if (otherClientId) await getPool().query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    clientId = '';
    otherClientId = '';
  });

  afterAll(async () => {
    await closePool();
  });

  async function seedClient(): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO client (name, slug) VALUES ('Reconciliation Export Co', $1) RETURNING id`,
      [`${tag}-${randomUUID()}`],
    );
    return rows[0]!.id;
  }

  it('creates a pending export request and reports it via status read', async () => {
    clientId = await seedClient();

    const created = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-1' }));
    expect(created.created).toBe(true);

    const row = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getReconciliationExport(client, { clientId, exportId: created.exportId }));
    expect(row).toMatchObject({ id: created.exportId, status: 'pending', result: null, error: null, completedAt: null });
  });

  it('is idempotent: a repeated request with the same idempotencyKey returns the existing row', async () => {
    clientId = await seedClient();

    const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-dup' }));
    const second = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-dup' }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.exportId).toBe(first.exportId);
  });

  it('claims a pending row (flips it to claimed), processes it, and completeReconciliationExport persists the result', async () => {
    clientId = await seedClient();
    const requested = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-claim' }));

    const claimed = await withTenantTx({ internal: true }, (client) =>
      claimDueReconciliationExports(client, { clientId, now: new Date() }));
    expect(claimed).toEqual([{ exportId: requested.exportId, idempotencyKey: 'req-claim' }]);

    // A second claim attempt finds nothing -- the UPDATE...RETURNING already
    // flipped it to 'claimed', so it's no longer selected by status = 'pending'.
    const secondClaim = await withTenantTx({ internal: true }, (client) =>
      claimDueReconciliationExports(client, { clientId, now: new Date() }));
    expect(secondClaim).toEqual([]);

    const bucket = { currency: 'USD', claimed: '100.0000', recovered: '100.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true };
    const completed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      completeReconciliationExport(client, { clientId, exportId: requested.exportId, result: [bucket] }));
    expect(completed).toEqual({ found: true });

    const row = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getReconciliationExport(client, { clientId, exportId: requested.exportId }));
    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual([bucket]);
    expect(row?.completedAt).not.toBeNull();
  });

  it('claims and fails a row with failReconciliationExport, recording the error', async () => {
    clientId = await seedClient();
    const requested = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-fail' }));
    await withTenantTx({ internal: true }, (client) =>
      claimDueReconciliationExports(client, { clientId, now: new Date() }));

    const failed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      failReconciliationExport(client, { clientId, exportId: requested.exportId, error: 'computation failed' }));
    expect(failed).toEqual({ found: true });

    const row = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getReconciliationExport(client, { clientId, exportId: requested.exportId }));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('computation failed');
    expect(row?.completedAt).not.toBeNull();
  });

  it('never claims or returns another tenant\'s export row (RLS)', async () => {
    clientId = await seedClient();
    otherClientId = await seedClient();

    const mine = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'req-mine' }));

    // The other tenant's scoped read never sees my row.
    const notVisible = await withTenantTx({ clientIds: [otherClientId], internal: false }, (client) =>
      getReconciliationExport(client, { clientId: otherClientId, exportId: mine.exportId }));
    expect(notVisible).toBeNull();

    // A cross-tenant claim scoped to otherClientId claims nothing of mine.
    const crossClaim = await withTenantTx({ internal: true }, (client) =>
      claimDueReconciliationExports(client, { clientId: otherClientId, now: new Date() }));
    expect(crossClaim).toEqual([]);
  });
});
