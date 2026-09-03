import { test, expect } from '@playwright/test';
import pg from 'pg';
import { getAuth } from '../../../src/auth/better-auth.js';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { seedCriteria } from '../../../scripts/seed-criteria.mjs';
import { loginViaForm } from './login-form.js';

// 86e33qzu4: proves cross-tenant isolation at the REAL browser/session
// level -- real better-auth sessions for two distinct tenants, real login
// form, real Fastify server, real Postgres. Per this task's own
// Rabbit-holes note, deliberately uses THIS harness
// (web/test/e2e-fullstack-auth, playwright.fullstack-auth.config.ts) rather
// than the DEV_AUTH_HEADERS tier -- that shortcut is exactly what this task
// is testing the absence of a gap around, not a substitute for it.
//
// Both tenant accounts are created directly via getAuth().api.signUpEmail()
// (in-process, same pattern as scripts/seed-e2e-auth-user.mjs) rather than
// through the real HTTP POST /api/auth/sign-up/email -- this bypasses
// auth-routes.ts's isBlockedPublicSignup gate entirely (that gate only
// checks the HTTP route path, confirmed by reading auth-routes.ts), so no
// PUBLIC_SIGNUP_ENABLED env var is needed for this spec's own setup, unlike
// passkey.fullstack.spec.ts's real-signup-through-the-browser test.
//
// Both accounts are marked is_internal=true (mirroring seed-e2e-auth-user.mjs
// exactly) so App.tsx routes each to the internal Dashboard, matching this
// task's own "loads the Dashboard" wording -- confirmed via App.tsx that a
// non-internal (client_admin/client_viewer) session instead routes to
// PortalApp. This does NOT broaden either session's data access:
// tenant-auth.ts's resolveViaSession (the standard path findings-routes.ts
// uses) always scopes to exactly the one x-client-id the frontend sends,
// gated by a real membership row, regardless of is_internal -- is_internal
// only affects UI routing here, not RLS scope (the special
// internal-analyst-auth.ts cross-client path is portfolio-routes.ts only,
// never touched by this spec).
//
// No z.uuid()-on-clientId concern (round 94's bug class): better-auth's own
// generateId (randomUUID(), src/auth/better-auth.ts) and this spec's own
// gen_random_uuid()-backed client rows are both real RFC4122 UUIDs.

let pool: pg.Pool;
let clientAId: string;
let clientBId: string;
let userAId: string;
let userBId: string;
let findingBId: string;

const EMAIL_A = `e2e-tenant-isolation-a-${Date.now()}@example.test`;
const EMAIL_B = `e2e-tenant-isolation-b-${Date.now()}@example.test`;
const PASSWORD = 'e2e-tenant-isolation-password-86e33qzu4';
const INVOICE_A = `INV-ISOA-${Date.now()}`;
const INVOICE_B = `INV-ISOB-${Date.now()}`;

async function seedFinding(client: pg.PoolClient, clientId: string, carrierId: string, invoiceNumber: string): Promise<string> {
  const invoice = await client.query<{ id: string }>(
    `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
     VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
    [clientId, carrierId, invoiceNumber],
  );
  const invoiceId = invoice.rows[0]!.id;
  const run = await client.query<{ id: string }>(
    `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
    [clientId, invoiceId],
  );
  const auditRunId = run.rows[0]!.id;
  const vf = await client.query<{ id: string }>(
    `INSERT INTO variance_finding
       (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
     SELECT $1, $2, c.id, rv.id, 'OVERCHARGE', '75.0000', 'USD', 'open', '{}'::jsonb
     FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
     JOIN rule_version rv ON rv.rule_id = r.id
     WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
    [clientId, auditRunId],
  );
  return vf.rows[0]!.id;
}

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedCriteria({ client: pool });

  const clientA = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Cross-Tenant Isolation Client A', $1) RETURNING id`,
    [`e2e-tenant-isolation-a-${Date.now()}`],
  );
  clientAId = clientA.rows[0]!.id;
  const clientB = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Cross-Tenant Isolation Client B', $1) RETURNING id`,
    [`e2e-tenant-isolation-b-${Date.now()}`],
  );
  clientBId = clientB.rows[0]!.id;

  const signUpA = await getAuth().api.signUpEmail({ body: { email: EMAIL_A, password: PASSWORD, name: 'E2E Isolation User A' } });
  userAId = signUpA.user.id;
  const signUpB = await getAuth().api.signUpEmail({ body: { email: EMAIL_B, password: PASSWORD, name: 'E2E Isolation User B' } });
  userBId = signUpB.user.id;

  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userAId, clientAId]);
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userBId, clientBId]);
  await pool.query(`UPDATE app_user SET is_internal = true WHERE id IN ($1, $2)`, [userAId, userBId]);

  await withTenantTx({ clientIds: [clientAId, clientBId], internal: true }, async (client) => {
    const carrierA = await client.query<{ id: string }>(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`E2E Isolation Carrier A ${Date.now()}`]);
    await seedFinding(client, clientAId, carrierA.rows[0]!.id, INVOICE_A);

    const carrierB = await client.query<{ id: string }>(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`E2E Isolation Carrier B ${Date.now()}`]);
    findingBId = await seedFinding(client, clientBId, carrierB.rows[0]!.id, INVOICE_B);
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM finding_status_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM carrier WHERE name LIKE 'E2E Isolation Carrier %'`);
  await pool.query(`DELETE FROM ba_session WHERE user_id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM ba_account WHERE user_id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM membership WHERE user_id IN ($1, $2)`, [userAId, userBId]);
  // Real sign-in writes a security-event audit_event referencing
  // actor_user_id -- must clear before app_user (audit_event_actor_user_id_fkey).
  await pool.query(`DELETE FROM audit_event WHERE actor_user_id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.end();
});

test('AC1: tenant A\'s real session loads the Dashboard showing only tenant A\'s findings, never tenant B\'s', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, EMAIL_A, PASSWORD);

  const rowA = page.getByTestId('finding-row').filter({ hasText: INVOICE_A });
  await expect(rowA).toBeVisible();

  // The unambiguous negative: tenant B's invoice number must appear nowhere
  // on the rendered page at all, not just "not in a finding-row."
  await expect(page.getByText(INVOICE_B)).toHaveCount(0);
});

test('AC2: tenant A\'s real session cannot act on a finding id known to belong to tenant B', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, EMAIL_A, PASSWORD);
  await expect(page.getByTestId('finding-row').filter({ hasText: INVOICE_A })).toBeVisible();

  // page.request shares this real, cookie-authenticated browser context --
  // the same request the status-change drawer itself would issue, including
  // the x-client-id header authHeaders() attaches from sessionStorage after
  // login (the session cookie alone identifies the user; tenant-auth.ts's
  // resolveViaSession still requires this header to resolve which tenant
  // scope to apply) -- aimed at a finding id this session was never given
  // and does not own.
  const response = await page.request.patch(`/api/findings/${findingBId}/status`, {
    headers: { 'x-client-id': clientAId },
    data: { status: 'in_review' },
  });
  expect(response.status()).toBe(404);

  // Confirm no leak AND no accidental write: tenant B's finding is
  // untouched, still exactly its original seeded status, and no status
  // history row was appended either -- a 404 plus an unchanged status
  // alone wouldn't rule out a partial write to the audit trail.
  const row = await pool.query<{ status: string }>(`SELECT status FROM variance_finding WHERE id = $1`, [findingBId]);
  expect(row.rows[0]!.status).toBe('open');
  const events = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM finding_status_event WHERE variance_finding_id = $1`, [findingBId]);
  expect(events.rows[0]!.n).toBe(0);
});
