import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { LocalDiskObjectStore } from '../../src/modules/reference-data/object-store.js';
import { ingestInvoice } from '../../src/modules/ingestion/ingest-invoice.js';

/**
 * 86e32tg6n: proves production invoice ingestion resolves charge codes
 * through the real DB-backed crosswalk (resolveChargeCode) rather than the
 * retired 4-entry stub -- specifically, that client/carrier precedence (§6.2)
 * is honored end to end through ingestInvoice, for a charge code ('FSC')
 * the stub never knew about at all.
 */
describe('Production charge-code categorization via the real crosswalk', () => {
  let pool: pg.Pool;
  let storeRoot: string;
  let clientId: string;
  let carrierId: string;
  const tag = `cw-${Date.now()}`;

  // A minimal, well-formed 210 with one L1 charge on a code the stub never
  // mapped ('FSC' -- the stub only ever knew 400/405/500/510). B3-11 carries
  // the SCAC of the carrier seeded below, so ingestInvoice's carrier lookup
  // resolves to a real carrier_id and the client+carrier+code (rank 4) row
  // wins over the carrier+code (rank 3) and global (rank 1) rows also seeded.
  const rawEdi =
    'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000042*0*P*>~' +
    'GS*IM*SENDER*RECEIVER*20260703*1200*42*X*004010~' +
    'ST*210*0042~' +
    'B3**INV-CW-1*SHIP-CW-1****500.00****WXYZ~' +
    'L1*1***500.00****FSC****Fuel Surcharge Override~' +
    'SE*5*0042~';

  beforeAll(async () => {
    pool = getPool();
    storeRoot = await mkdtemp(join(tmpdir(), 'fa-objstore-crosswalk-'));

    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('Crosswalk Co', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const car = await owner.query(`INSERT INTO carrier (name, scac_code) VALUES ('WXYZ Freight', 'WXYZ') RETURNING id`);
      carrierId = car.rows[0].id;

      // Full precedence ladder for carrierId+'FSC', same shape as
      // phase0-foundations.db.test.ts's AC5: rank 1 global, rank 3
      // carrier+code, rank 4 client+carrier+code (this client only).
      await owner.query(
        `INSERT INTO charge_code_crosswalk (client_id, carrier_id, source_code, canonical_category, precedence_rank)
         VALUES
           (NULL, NULL, 'FSC', 'FUEL_GLOBAL', 1),
           (NULL, $1, 'FSC', 'FUEL_CARRIER', 3),
           ($2, $1, 'FSC', 'FUEL_CLIENT_OVERRIDE', 4)`,
        [carrierId, clientId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_code_crosswalk WHERE carrier_id = $1`, [carrierId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await rm(storeRoot, { recursive: true, force: true });
    await closePool();
  });

  it('AC1/86e32tg6n: resolves a charge code the stub never knew via the crosswalk\'s client/carrier precedence', async () => {
    const store = new LocalDiskObjectStore(storeRoot);
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      ingestInvoice(c, store, { clientId, rawBytes: Buffer.from(rawEdi) }),
    );

    expect(result.outcome).toBe('SCORED');

    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const r = await c.query<{ category: string | null }>(
        `SELECT category FROM charge_fact WHERE invoice_id = $1 AND code = 'FSC'`,
        [result.invoiceId],
      );
      return r.rows[0];
    });

    expect(persisted).toBeDefined();
    // The client+carrier+code override (rank 4) wins over both the
    // carrier+code (rank 3) and global (rank 1) rows also seeded above --
    // and 'FSC' is not one of the stub's four codes, so this category could
    // only have come from the real crosswalk, never the retired stub.
    expect(persisted!.category).toBe('FUEL_CLIENT_OVERRIDE');
  });

  it('AC2/86e32tg6n: an unresolvable code (no crosswalk row at all) is honestly quarantined, never guessed', async () => {
    const rawUnresolvable =
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000043*0*P*>~' +
      'GS*IM*SENDER*RECEIVER*20260703*1200*43*X*004010~' +
      'ST*210*0043~' +
      'B3**INV-CW-2*SHIP-CW-2****500.00****WXYZ~' +
      'L1*1***500.00****ZZZZ****Unmapped Code~' +
      'SE*5*0043~';
    const store = new LocalDiskObjectStore(storeRoot);
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      ingestInvoice(c, store, { clientId, rawBytes: Buffer.from(rawUnresolvable) }),
    );

    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const r = await c.query<{ category: string | null }>(
        `SELECT category FROM charge_fact WHERE invoice_id = $1 AND code = 'ZZZZ'`,
        [result.invoiceId],
      );
      return r.rows[0];
    });

    expect(persisted).toBeDefined();
    expect(persisted!.category).toBeNull();
  });
});
