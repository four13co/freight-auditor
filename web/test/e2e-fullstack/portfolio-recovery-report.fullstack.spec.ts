import { test, expect } from '@playwright/test';
import pg from 'pg';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { assertSeeded } from '../e2e-fullstack-auth/assert-seeded.js';

// 86e33qzmr: full-stack e2e for the cross-client portfolio recovery report
// (portfolio-routes.ts) -- real Fastify server + real Postgres, real HTTP,
// no route mocking.
//
// Scope-honesty correction on AC1: its own text says "when an internal
// analyst views the portfolio recovery report" -- PortfolioReport.tsx's own
// doc comment states it is "Unwired to nav -- same disclosure as its P5.C
// siblings," confirmed via grep across web/src (only self-references and
// sibling-precedent comments, never imported into App.tsx/Dashboard.tsx).
// This is the same "no reachable UI surface exists anywhere in this flow"
// case P7.C.2's DisputeReview.tsx and P7.C.3's HTTP-only shape already
// established for this epic -- driven directly over real HTTP instead.
//
// No z.uuid()-on-clientId concern here (the round 94/95 bug class this
// epic keeps hitting): getCrossClientPortfolio takes NO clientId input at
// all -- it is deliberately unscoped, relying entirely on RLS's
// app_is_internal() branch. The internal-analyst auth preHandler
// (internal-analyst-auth.ts) reads only x-user-id, never x-client-id.
//
// Seeds two disposable clients directly (no shared DEV_CLIENT_ID fixture)
// so the assertions can scope to exactly what this spec seeded, since the
// real aggregation is genuinely platform-wide (every client with a claim
// row) and would otherwise pick up the dev fixture tenant and any other
// residual data.

let pool: pg.Pool;
let clientAId: string;
let clientBId: string;
let internalUserId: string;
let portalUserId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const clientA = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Portfolio Recovery Client A', $1) RETURNING id`,
    [`e2e-portfolio-a-${Date.now()}`],
  );
  clientAId = clientA.rows[0]!.id;
  const clientB = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Portfolio Recovery Client B', $1) RETURNING id`,
    [`e2e-portfolio-b-${Date.now()}`],
  );
  clientBId = clientB.rows[0]!.id;

  // is_internal=true: the real analyst identity the route's own preHandler
  // checks (internal-analyst-auth.ts's lookupIsInternal).
  const internalUser = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, is_internal) VALUES ($1, 'E2E Portfolio Internal Analyst', true) RETURNING id`,
    [`e2e-portfolio-internal-${Date.now()}@example.test`],
  );
  internalUserId = internalUser.rows[0]!.id;

  // is_internal defaults to false -- a real client-portal-scoped identity
  // (AC2's negative case), with a real membership under client A so it
  // mirrors an actual portal session's shape.
  const portalUser = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Portfolio Portal User') RETURNING id`,
    [`e2e-portfolio-portal-${Date.now()}@example.test`],
  );
  portalUserId = portalUser.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [portalUserId, clientAId]);

  await withTenantTx({ clientIds: [clientAId, clientBId], internal: true }, async (client) => {
    // Client A: claimed 300, recovered 100 (same currency) -> outstanding 200.
    const claimA = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '300.0000', 'USD', 'open') RETURNING id`,
      [clientAId],
    );
    await client.query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD')`,
      [clientAId, claimA.rows[0]!.id],
    );

    // Client B: claimed 150, no recovery yet -> outstanding 150.
    await client.query(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '150.0000', 'USD', 'open')`,
      [clientBId],
    );
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM membership WHERE user_id = $1`, [portalUserId]);
  await pool.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [internalUserId, portalUserId]);
  await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.end();
});

interface PortfolioBucket {
  clientId: string;
  clientName: string | null;
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  reconciles: boolean;
}

test('AC1: an internal analyst can view real, correctly aggregated cross-client recovery figures', async ({ request }) => {
  // assertSeeded per this task's own Rabbit-holes note: a 200 with an empty
  // bucket list would look deceptively like a pass for an aggregation view
  // -- fail loudly if our two seeded clients aren't actually present.
  await assertSeeded(request, {
    check: () => request.get('/api/portfolio/cross-client-recovery', { headers: { 'x-user-id': internalUserId } }),
    errorHint: 'expected the cross-client portfolio endpoint to return the two seeded client buckets',
    validate: async (response) => {
      const { buckets } = await response.json() as { buckets: PortfolioBucket[] };
      return buckets.some((b) => b.clientId === clientAId) && buckets.some((b) => b.clientId === clientBId);
    },
  });

  const response = await request.get('/api/portfolio/cross-client-recovery', { headers: { 'x-user-id': internalUserId } });
  expect(response.status()).toBe(200);
  const { buckets } = await response.json() as { buckets: PortfolioBucket[] };

  const bucketA = buckets.find((b) => b.clientId === clientAId);
  expect(bucketA).toBeDefined();
  expect(bucketA!.clientName).toBe('E2E Portfolio Recovery Client A');
  expect(bucketA!.claimed).toBe('300.0000');
  expect(bucketA!.recovered).toBe('100.0000');
  expect(bucketA!.outstanding).toBe('200.0000');
  expect(bucketA!.reconciles).toBe(true);

  const bucketB = buckets.find((b) => b.clientId === clientBId);
  expect(bucketB).toBeDefined();
  expect(bucketB!.clientName).toBe('E2E Portfolio Recovery Client B');
  expect(bucketB!.claimed).toBe('150.0000');
  expect(bucketB!.recovered).toBe('0.0000');
  expect(bucketB!.outstanding).toBe('150.0000');
  expect(bucketB!.reconciles).toBe(true);
});

test('AC2: a client-portal-scoped session cannot reach the internal-only portfolio report', async ({ request }) => {
  const response = await request.get('/api/portfolio/cross-client-recovery', {
    headers: { 'x-client-id': clientAId, 'x-user-id': portalUserId },
  });
  expect(response.status()).toBe(401);
});
