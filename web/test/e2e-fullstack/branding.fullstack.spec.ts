import { test, expect } from '@playwright/test';
import pg from 'pg';

// 86e33tmnp: full-stack e2e for per-customer white-label branding
// (86e320pkc) -- real Fastify server + real Postgres + real browser, no
// route mocking. resolveBrandingByDomain resolves purely by the request's
// Host header (src/modules/identity/resolve-branding-by-domain.ts), so the
// browser needs to send a REAL Host header for a fixture domain. Chromium
// disallows overriding Host via page.setExtraHTTPHeaders or page.route's
// header interception (confirmed empirically -- both are silently ignored,
// the underlying network stack computes Host from the actual connection
// target, not from JS-level header manipulation). --host-resolver-rules
// maps the fixture hostnames to 127.0.0.1 at the OS-resolution layer instead,
// so navigating to http://<fixture-domain>:4180/ makes Chromium open a real
// connection to the test server while sending a genuine
// `Host: <fixture-domain>:4180` header -- exactly what production traffic
// would send once DNS is configured for a real customer domain. No DNS/TLS
// provisioning needed (that's explicitly out of scope, same exclusion
// 86e320pkc itself drew).
//
// No admin write API/UI exists by design (86e320pkc's own scoped-out
// decision) -- customer_branding rows are seeded directly via SQL here,
// the same way other config-only tables are seeded elsewhere in this suite.

const DOMAIN_D1 = `branding-d1-${Date.now()}.test.example`;
const DOMAIN_D2 = `branding-d2-${Date.now()}.test.example`;
// Must match playwright.fullstack.config.ts's own `use.baseURL` port -- a
// fixture-domain URL needs an explicit host+port (relative '/' would resolve
// against the real baseURL, not the fixture domain), and launchOptions is
// set at module scope, before any fixture (including baseURL) is available
// to read dynamically.
const PORT = '4180';

test.use({
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${DOMAIN_D1} 127.0.0.1,MAP ${DOMAIN_D2} 127.0.0.1`],
  },
});

let pool: pg.Pool;
let clientD1Id: string;
let clientD2Id: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const clientD1 = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Branding Client D1', $1) RETURNING id`,
    [`e2e-branding-d1-${Date.now()}`],
  );
  clientD1Id = clientD1.rows[0]!.id;
  const clientD2 = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Branding Client D2', $1) RETURNING id`,
    [`e2e-branding-d2-${Date.now()}`],
  );
  clientD2Id = clientD2.rows[0]!.id;

  await pool.query(
    `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
     VALUES ($1, $2, 'https://cdn.example.test/d1-logo.png', '#1a2b3c', '#4d5e6f')`,
    [clientD1Id, DOMAIN_D1],
  );
  await pool.query(
    `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
     VALUES ($1, $2, 'https://cdn.example.test/d2-logo.png', '#aa1122', '#bb3344')`,
    [clientD2Id, DOMAIN_D2],
  );
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM customer_branding WHERE client_id IN ($1, $2)`, [clientD1Id, clientD2Id]);
  await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientD1Id, clientD2Id]);
  await pool.end();
});

test('AC1: a browser session visiting a branded domain renders that domain\'s logo and CSS custom properties', async ({ page }) => {
  await page.goto(`http://${DOMAIN_D1}:${PORT}/`);

  const logo = page.getByTestId('brand-mark-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', 'https://cdn.example.test/d1-logo.png');

  const [primary, secondary] = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return [style.getPropertyValue('--brand-primary').trim(), style.getPropertyValue('--brand-secondary').trim()];
  });
  expect(primary).toBe('#1a2b3c');
  expect(secondary).toBe('#4d5e6f');
});

test('AC2: a browser session visiting the platform\'s default (unbranded) host renders the default mark, unaffected by any configured domain', async ({ page }) => {
  // baseURL (localhost:4180) -- the platform's own default host, which has
  // no customer_branding row.
  await page.goto('/');

  await expect(page.getByTestId('brand-mark-default')).toBeVisible();
  await expect(page.getByTestId('brand-mark-logo')).toHaveCount(0);

  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim());
  expect(primary).toBe('');
});

test('AC3: two branded domains never bleed into each other -- re-navigating with a different Host swaps to that domain\'s own branding', async ({ page }) => {
  await page.goto(`http://${DOMAIN_D1}:${PORT}/`);
  await expect(page.getByTestId('brand-mark-logo')).toHaveAttribute('src', 'https://cdn.example.test/d1-logo.png');

  await page.goto(`http://${DOMAIN_D2}:${PORT}/`);
  const logo = page.getByTestId('brand-mark-logo');
  await expect(logo).toHaveAttribute('src', 'https://cdn.example.test/d2-logo.png');
  // D1's own logo URL is fully absent from the page, not just superseded on
  // the one <img> BrandMark renders -- the assertion "no bleed-through"
  // actually needs, distinct from "src holds D2's own value" above.
  await expect(page.locator('img[src="https://cdn.example.test/d1-logo.png"]')).toHaveCount(0);

  const [primary, secondary] = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return [style.getPropertyValue('--brand-primary').trim(), style.getPropertyValue('--brand-secondary').trim()];
  });
  expect(primary).toBe('#aa1122');
  expect(secondary).toBe('#bb3344');
});
