import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { LocalDiskObjectStore, sha256Hex } from '../../src/modules/reference-data/object-store.js';
import { storeSourceDocument } from '../../src/modules/reference-data/source-document.js';
import { resolveChargeCode } from '../../src/modules/reference-data/crosswalk.js';
import {
  createClient,
  createCarrier,
  storeOnboardingDocuments,
} from '../../src/modules/identity/onboarding.js';

/**
 * Phase 0 foundations contract (ClickUp 86e24cy4b). Proves the RUNTIME
 * enforcement of the trust foundation (Master Spec §11, §12): tenant isolation
 * via RLS through the real withTenantTx plumbing, the append-only ledger,
 * content-addressed immutable storage, and crosswalk precedence.
 *
 * Runs against the ephemeral container Postgres via DATABASE_URL. The runtime's
 * `SET LOCAL ROLE freight_app` is what makes RLS bind, so these prove isolation
 * under the NON-superuser role, not the owner.
 */
describe('Phase 0 foundations (runtime)', () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;
  let carrierId: string;
  let storeRoot: string;

  // Seed two real (committed) clients + a carrier so isolation can be observed
  // across separate withTenantTx transactions. Owner connection bypasses RLS for
  // the seed. Everything is namespaced by a run tag and torn down in afterAll.
  const tag = `p0-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    storeRoot = await mkdtemp(join(tmpdir(), 'fa-objstore-'));

    const owner = await pool.connect();
    try {
      const a = await owner.query(
        `INSERT INTO client (name, slug) VALUES ('Alpha', $1) RETURNING id`,
        [`${tag}-a`],
      );
      const b = await owner.query(
        `INSERT INTO client (name, slug) VALUES ('Bravo', $1) RETURNING id`,
        [`${tag}-b`],
      );
      clientA = a.rows[0].id;
      clientB = b.rows[0].id;

      const car = await owner.query(`INSERT INTO carrier (name) VALUES ('Carrier X') RETURNING id`);
      carrierId = car.rows[0].id;

      // A tenant-scoped row per client on a tenant table (membership needs a user).
      const ua = await owner.query(
        `INSERT INTO app_user (email) VALUES ($1) RETURNING id`,
        [`${tag}-ua@x.test`],
      );
      const ub = await owner.query(
        `INSERT INTO app_user (email) VALUES ($1) RETURNING id`,
        [`${tag}-ub@x.test`],
      );
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1,$2,'analyst')`,
        [ua.rows[0].id, clientA],
      );
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1,$2,'analyst')`,
        [ub.rows[0].id, clientB],
      );

      // Crosswalk rows exercising the full precedence ladder for carrierId+'FSC':
      //   rank 1 global (carrier NULL, client NULL), rank 3 carrier+code,
      //   rank 4 client+carrier+code (for clientA only).
      await owner.query(
        `INSERT INTO charge_code_crosswalk
           (client_id, carrier_id, source_code, canonical_category, precedence_rank)
         VALUES
           (NULL, NULL, 'FSC', 'FUEL_GLOBAL', 1),
           (NULL, $1, 'FSC', 'FUEL_CARRIER', 3),
           ($2, $1, 'FSC', 'FUEL_CLIENT_A', 4)`,
        [carrierId, clientA],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      // Tear down seeded rows (children first). Scoped by the run tag / ids.
      await owner.query(`DELETE FROM charge_code_crosswalk WHERE carrier_id = $1`, [carrierId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = ANY($1)`, [
        [clientA, clientB],
      ]);
      await owner.query(`DELETE FROM membership WHERE client_id = ANY($1)`, [[clientA, clientB]]);
      await owner.query(`DELETE FROM app_user WHERE email LIKE $1`, [`${tag}-%`]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientA, clientB]]);
    } finally {
      owner.release();
    }
    await rm(storeRoot, { recursive: true, force: true });
    await closePool();
  });

  it('AC1: a non-internal request scoped to A cannot see B rows (RLS blocks cross-tenant)', async () => {
    const rows = await withTenantTx({ clientIds: [clientA], internal: false }, async (c) => {
      const r = await c.query(`SELECT client_id FROM membership`);
      return r.rows;
    });
    // Only A's membership is visible; B is invisible.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.client_id === clientA)).toBe(true);
    expect(rows.some((r) => r.client_id === clientB)).toBe(false);
  });

  it('AC1b: scoping to A returns zero of B specifically', async () => {
    const count = await withTenantTx({ clientIds: [clientA], internal: false }, async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM membership WHERE client_id = $1`, [
        clientB,
      ]);
      return r.rows[0].n as number;
    });
    expect(count).toBe(0);
  });

  it('AC2: an internal analyst sees rows across clients A and B (portfolio access)', async () => {
    const seen = await withTenantTx({ internal: true }, async (c) => {
      const r = await c.query(`SELECT DISTINCT client_id FROM membership WHERE client_id = ANY($1)`, [
        [clientA, clientB],
      ]);
      return new Set(r.rows.map((row) => row.client_id));
    });
    expect(seen.has(clientA)).toBe(true);
    expect(seen.has(clientB)).toBe(true);
  });

  it('AC3: audit_event rejects UPDATE and DELETE for the app role (append-only)', async () => {
    await expect(
      withTenantTx({ internal: true }, async (c) => {
        await c.query(`UPDATE audit_event SET event = 'x' WHERE false`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTx({ internal: true }, async (c) => {
        await c.query(`DELETE FROM audit_event WHERE false`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('AC4: source documents are sha256-addressed and idempotent on re-store', async () => {
    const store = new LocalDiskObjectStore(storeRoot);
    const bytes = Buffer.from('ISA*00*...raw-edi-payload...~');
    const expectedSha = sha256Hex(bytes);

    const first = await withTenantTx({ clientIds: [clientA], internal: true }, async (c) =>
      storeSourceDocument(c, store, { clientId: clientA, bytes, contentType: 'application/edi-x12' }),
    );
    const second = await withTenantTx({ clientIds: [clientA], internal: true }, async (c) =>
      storeSourceDocument(c, store, { clientId: clientA, bytes, contentType: 'application/edi-x12' }),
    );

    expect(first.sha256).toBe(expectedSha);
    expect(second.sha256).toBe(expectedSha);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // idempotent — no duplicate row
    expect(second.id).toBe(first.id); // same document ref
    // Bytes retrievable and identical.
    expect((await store.get(expectedSha)).equals(bytes)).toBe(true);
  });

  it('AC4b: cross-tenant sha256 collision returns the existing ref instead of throwing', async () => {
    const store = new LocalDiskObjectStore(storeRoot);
    const bytes = Buffer.from('ISA*00*...shared-carrier-boilerplate...~');
    const expectedSha = sha256Hex(bytes);

    // Tenant A stores the bytes first, under a genuinely restricted (non-internal) scope.
    const first = await withTenantTx({ clientIds: [clientA], internal: false }, async (c) =>
      storeSourceDocument(c, store, { clientId: clientA, bytes, contentType: 'application/edi-x12' }),
    );
    // Tenant B stores byte-identical content, also non-internal — B's RLS scope
    // cannot see A's row, yet the global UNIQUE(sha256) index still conflicts.
    const second = await withTenantTx({ clientIds: [clientB], internal: false }, async (c) =>
      storeSourceDocument(c, store, { clientId: clientB, bytes, contentType: 'application/edi-x12' }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // no duplicate row inserted for B
    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(expectedSha);
    expect(second.storageUri).toBe(first.storageUri);
    expect(second.byteSize).toBe(first.byteSize);
  });

  it('AC5: crosswalk resolves the most-specific rule per precedence', async () => {
    // Client A has a client+carrier+code override (rank 4) → wins.
    const forA = await withTenantTx({ clientIds: [clientA], internal: false }, async (c) =>
      resolveChargeCode(c, { carrierId, sourceCode: 'FSC' }),
    );
    expect(forA?.canonicalCategory).toBe('FUEL_CLIENT_A');
    expect(forA?.precedenceRank).toBe(4);

    // Client B has no override → carrier+code (rank 3) wins over global (rank 1).
    const forB = await withTenantTx({ clientIds: [clientB], internal: false }, async (c) =>
      resolveChargeCode(c, { carrierId, sourceCode: 'FSC' }),
    );
    expect(forB?.canonicalCategory).toBe('FUEL_CARRIER');
    expect(forB?.precedenceRank).toBe(3);
  });

  it('Exit criterion (§12): onboard a client + carrier and store raw EDI + contract PDF immutably', async () => {
    const store = new LocalDiskObjectStore(storeRoot);
    const result = await withTenantTx({ internal: true }, async (c) => {
      const cl = await createClient(c, { name: 'Onboarded Co', slug: `${tag}-onb` });
      const car = await createCarrier(c, { name: 'Onboard Carrier', scacCode: 'ONBD' });
      const docs = await storeOnboardingDocuments(c, store, {
        clientId: cl.id,
        rawEdi: Buffer.from(`ISA*edi*${tag}~`),
        contractPdf: Buffer.from(`%PDF-1.7 ${tag}`),
      });
      return { cl, car, docs };
    });

    expect(result.cl.id).toBeTruthy();
    expect(result.car.id).toBeTruthy();
    expect(result.docs.rawEdi.created).toBe(true);
    expect(result.docs.contractPdf.created).toBe(true);
    expect(result.docs.rawEdi.sha256).not.toBe(result.docs.contractPdf.sha256);

    // Cleanup the committed onboarding rows (they're outside the tag-scoped seed teardown paths above for client id).
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [result.cl.id]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [result.car.id]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [result.cl.id]);
    } finally {
      owner.release();
    }
  });
});
