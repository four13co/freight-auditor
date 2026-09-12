import { test, expect } from '@playwright/test';
import { DASHBOARD_ROWS as ROWS, DASHBOARD_SUMMARY as SUMMARY } from '../fixtures.js';

/**
 * Renders the real dashboard page (Principle 1/7: a render test is part of
 * the contract for any UI change) with both API endpoints route-intercepted
 * -- deterministic, no live backend needed. This surface is in-design (not
 * blessed), so this is a perceptual-only capture: no toHaveScreenshot
 * baseline committed.
 *
 * 86e2zfjmb: this config's webServer is `vite preview` -- static files only,
 * no real Fastify/better-auth backend behind it, and this file never mocked
 * /api/auth/* -- every request to it previously fell through to vite
 * preview's own SPA fallback (a 200 with index.html's body). App.tsx's old,
 * pre-actor-type-routing code happened to reach the Dashboard anyway despite
 * that (a stray unhandled rejection from parsing that HTML as JSON, masked
 * by a .finally() that ran regardless). Now that a resolved session also
 * needs a real isInternal/role answer to route correctly, that incidental
 * path lands on the client portal shell instead of the Dashboard this suite
 * actually exercises -- so /api/auth/get-session and /api/auth/memberships
 * are mocked explicitly here, same as every other endpoint this file already
 * intercepts, rather than continuing to rely on undefined fallback behavior.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) => route.fulfill({
    json: { user: { id: 'dana-1', email: 'dana@example.com', name: 'Dana Mercer' }, session: { id: 'session-1' } },
  }));
  await page.route('**/api/auth/memberships', (route) => route.fulfill({
    json: { clientIds: ['11111111-1111-1111-1111-111111111111'], isInternal: true, role: null },
  }));
});

test('dashboard renders the 1B Console layout with real (mocked) API data', async ({ page }) => {
  // Playwright matches the most-recently-registered route first, and
  // '**/api/findings**' also matches '/api/findings/summary' -- register the
  // broader pattern first so the more specific one wins.
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');

  await expect(page.getByText('Good morning, Dana')).toBeVisible();
  await expect(page.getByTestId('kpi-row')).toBeVisible();
  await expect(page.getByTestId('finding-row')).toHaveCount(3);

  await page.screenshot({ path: 'test-results/dashboard-full.png', fullPage: true });
});

/**
 * 86e36xk28 AC6: the sidebar's header/footer hairline borders render at the
 * new 1px weight in a real browser, not just as a className assertion in
 * jsdom -- computed styles are the only way to catch a Tailwind class that
 * doesn't actually resolve to the intended width.
 */
test('sidebar header and footer borders render at 1px, not 2px', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');

  const header = page.getByTestId('sidebar-header');
  const footer = page.getByTestId('sidebar-footer');
  await expect(header).toBeVisible();
  await expect(footer).toBeVisible();

  const headerBorderWidth = await header.evaluate((el) => getComputedStyle(el).borderBottomWidth);
  const footerBorderWidth = await footer.evaluate((el) => getComputedStyle(el).borderTopWidth);

  expect(headerBorderWidth).toBe('1px');
  expect(footerBorderWidth).toBe('1px');
});

/**
 * 86e2urn2t: the error state is new surface, not just a check that the
 * happy path is unbroken -- captured for the same perceptual-review reason
 * as the happy-path render above.
 */
test('dashboard shows a distinct error state (not the empty-table markup) when a fetch fails', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ status: 500, body: '' }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ status: 500, body: '' }));

  await page.goto('/');

  await expect(page.getByTestId('dashboard-error')).toBeVisible();
  await expect(page.getByText('No findings match these filters.')).not.toBeVisible();
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();

  await page.screenshot({ path: 'test-results/dashboard-error.png', fullPage: true });
});

/**
 * 86e2uutk8 AC1/AC2: clicking a row opens a detail view scoped to that row's
 * own data (not any row's -- INV-90408 must not leak into the panel opened
 * from row 1), and Escape closes it. Scoped queries throughout since the
 * invoice number and other fields also appear in the table row behind the
 * panel -- an unscoped getByText would be a strict-mode violation.
 */
test('clicking a finding row opens its detail view; Escape closes it', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');
  await expect(page.getByTestId('finding-row')).toHaveCount(3);

  await page.getByTestId('finding-row').first().click();

  const detail = page.getByTestId('finding-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('INV-90385')).toBeVisible();
  await expect(detail.getByText('Saia LTL')).toBeVisible();
  await expect(detail.getByText('INV-90408')).not.toBeVisible();

  await page.screenshot({ path: 'test-results/dashboard-detail.png', fullPage: true });

  await page.keyboard.press('Escape');
  await expect(detail).not.toBeVisible();
});

/**
 * 86e37r2rm: proves the real, built app renders the dedicated /discrepancies
 * route (a render test is part of the contract for any UI change, same as
 * the rest of this file) -- reuses the same mocked /api/findings response as
 * the happy-path test above, on the new route, with no KPI row alongside it.
 */
test('86e37r2rm AC1: the "Discrepancies" sidebar link navigates to /#/discrepancies and renders the findings table there', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Discrepancies').click();

  await expect(page).toHaveURL(/\/#\/discrepancies$/);
  await expect(page.getByTestId('finding-row')).toHaveCount(3);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();

  await page.screenshot({ path: 'test-results/discrepancies-full.png', fullPage: true });
});

/**
 * 86e37r2rv AC3: proves the real, built app renders the dedicated /audit-log
 * route (a render test is part of the contract for any UI change, same as
 * the rest of this file) -- the sidebar link navigates there and the
 * internal audit-log endpoint's mocked rows render, paginated the same way
 * the client portal's own view does.
 */
test('86e37r2rv AC3: the "Audit log" sidebar link navigates to /#/audit-log and renders the audit log table there', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));
  await page.route('**/api/internal/audit-log**', (route) => route.fulfill({
    json: {
      events: [
        { id: 'e-1', entity: 'dispute', entityId: null, event: 'created', actorKind: 'analyst', recordedAt: '2026-01-15T00:00:00Z' },
        { id: 'e-2', entity: 'claim', entityId: null, event: 'opened', actorKind: 'system', recordedAt: '2026-01-16T00:00:00Z' },
      ],
    },
  }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Audit log').click();

  await expect(page).toHaveURL(/\/#\/audit-log$/);
  await expect(page.getByTestId('audit-log-row')).toHaveCount(2);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();

  await page.screenshot({ path: 'test-results/audit-log-full.png', fullPage: true });
});

/**
 * 86e37r2rt AC3: proves the real, built app renders the dedicated /invoices
 * route (a render test is part of the contract for any UI change, same as
 * the rest of this file) -- the sidebar link navigates there and the
 * invoice list endpoint's mocked rows render, with billedTotal formatted the
 * same way FindingsTable's own money columns are.
 */
test('86e37r2rt AC3: the "Invoices" sidebar link navigates to /#/invoices and renders the invoice table there', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));
  await page.route('**/api/invoices**', (route) => route.fulfill({
    json: {
      invoices: [
        { id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Saia LTL', transactionSet: '210', status: 'ingested', currency: 'USD', createdAt: '2026-01-15T00:00:00Z', billedTotal: '1250.5000' },
        { id: 'inv-2', invoiceNumber: 'INV-2', carrierName: 'Estes', transactionSet: '210', status: 'ingested', currency: 'USD', createdAt: '2026-01-16T00:00:00Z', billedTotal: null },
      ],
    },
  }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Invoices').click();

  await expect(page).toHaveURL(/\/#\/invoices$/);
  await expect(page.getByTestId('invoice-row')).toHaveCount(2);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();

  await page.screenshot({ path: 'test-results/invoices-full.png', fullPage: true });
});

/**
/**
 * 86e37r2t8 AC6: proves the real, built app renders /discrepancies with the
 * assignee=me + minAmount presets applied when reached via the "Mine, over
 * $500" saved view -- URL round-trip + the request actually carrying both
 * filters through to the backend (the server-side filtering itself is
 * covered by assign-finding.db.test.ts; this only proves the sidebar link
 * -> URL -> request wiring, same convention as the other two saved views).
 */
test('86e37r2t8 AC6: the "Mine, over $500" saved view navigates to /#/discrepancies?assignee=me&minAmount=500 and requests both filters', async ({ page }) => {
  let requestedUrl = '';
  await page.route('**/api/findings**', (route) => {
    requestedUrl = route.request().url();
    return route.fulfill({ json: { findings: ROWS } });
  });
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Mine, over $500').click();

  await expect(page).toHaveURL(/\/#\/discrepancies\?assignee=me&minAmount=500$/);
  await expect(page.getByTestId('finding-row')).toHaveCount(3);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();
  await expect.poll(() => requestedUrl).toContain('assignee=me');
  await expect.poll(() => requestedUrl).toContain('min-amount=500');

  await page.screenshot({ path: 'test-results/mine-saved-view-full.png', fullPage: true });
});

/**
 * 86e37r2t8 AC5: an internal analyst assigns a finding to themselves from
 * the real table, then clicking "Mine, over $500" surfaces it -- proves the
 * whole self-assign loop end to end (button -> PATCH -> re-render ->
 * saved-view filter), not just the individual pieces the unit/db tests
 * already cover. Unassigning afterward is proven separately in
 * FindingsTable.test.tsx (it patches local row state without a refetch,
 * same convention as onRowStatusChange -- so it's a jsdom-level, not
 * real-browser, concern).
 */
test('86e37r2t8 AC5: assigning a finding to self then clicking "Mine, over $500" surfaces it', async ({ page }) => {
  let assignedToUserId: string | null = null;
  await page.route('**/api/findings**', (route) => {
    const url = route.request().url();
    const withAssignee = ROWS.map((r) => (r.id === 'f1' ? { ...r, assignedToUserId } : r));
    const findings = url.includes('assignee=me')
      ? withAssignee.filter((r) => r.id === 'f1' && assignedToUserId !== null)
      : withAssignee;
    return route.fulfill({ json: { findings } });
  });
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));
  await page.route('**/api/findings/f1/assign', (route) => {
    const body = route.request().postDataJSON() as { userId: string | null };
    assignedToUserId = body.userId === null ? null : 'user-1';
    return route.fulfill({ json: { assignedToUserId } });
  });

  await page.goto('/');
  await expect(page.getByTestId('finding-row')).toHaveCount(3);

  const firstRow = page.getByTestId('finding-row').first();
  await firstRow.getByText('Assign to me').click();
  await expect(firstRow.getByText('Unassign')).toBeVisible();

  await page.getByText('Mine, over $500').click();
  await expect(page).toHaveURL(/\/#\/discrepancies\?assignee=me&minAmount=500$/);
  await expect(page.getByTestId('finding-row')).toHaveCount(1);
  await expect(page.getByTestId('finding-row').first().getByText('Unassign')).toBeVisible();

  await page.screenshot({ path: 'test-results/mine-assigned-full.png', fullPage: true });
});

/**
 * 86e37r2t4 AC4: proves the real, built app renders the dedicated /settings
 * route and that an edit+save round-trips through PATCH /api/internal/branding
 * and persists across a reload -- a render test is part of the contract for
 * any UI change, same as the rest of this file. GET /api/branding and PATCH
 * /api/internal/branding are both intercepted against one mutable in-memory
 * `branding` object (not two independent fixed fixtures), so a PATCH's effect
 * is actually visible on the next GET -- the same "reload after save" this
 * AC names, without requiring a live backend/DB.
 */
test('86e37r2t4 AC4: the "Settings" sidebar link navigates to /#/settings, and an edit+save persists across a reload', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  let branding: { branded: boolean; logoUrl: string; primaryColor: string; secondaryColor: string | null } =
    { branded: true, logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: '#445566' };
  await page.route('**/api/branding', (route) => route.fulfill({ json: branding }));
  await page.route('**/api/internal/branding', (route) => {
    const body = route.request().postDataJSON() as { logoUrl: string; primaryColor: string; secondaryColor: string | null };
    branding = { branded: true, ...body };
    return route.fulfill({ json: { logoUrl: body.logoUrl, primaryColor: body.primaryColor, secondaryColor: body.secondaryColor } });
  });

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Settings').click();
  await expect(page).toHaveURL(/\/#\/settings$/);
  await expect(page.getByLabel('Primary color')).toHaveValue('#112233');

  await page.getByLabel('Primary color').fill('#abcdef');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  await page.screenshot({ path: 'test-results/settings-full.png', fullPage: true });

  // HashRouter keeps '#/settings' across a reload -- the app re-mounts
  // straight onto /settings, no click needed.
  await page.reload();
  await expect(page.getByLabel('Primary color')).toHaveValue('#abcdef');
});

/**
 * 86e37r2t6 AC3: proves the real, built app renders /discrepancies with the
 * minAgeDays preset applied when reached via the "Aging > 5 days" saved
 * view -- URL round-trip + the request actually carrying min-age-days
 * through to the backend (the filtering itself is covered server-side by
 * list-findings.db.test.ts; this only proves the sidebar link -> URL ->
 * request wiring).
 */
test('86e37r2t6 AC3: the "Aging > 5 days" saved view navigates to /#/discrepancies?minAgeDays=5 and requests min-age-days=5', async ({ page }) => {
  let requestedUrl = '';
  await page.route('**/api/findings**', (route) => {
    requestedUrl = route.request().url();
    return route.fulfill({ json: { findings: ROWS } });
  });
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Aging > 5 days').click();

  await expect(page).toHaveURL(/\/#\/discrepancies\?minAgeDays=5$/);
  await expect(page.getByTestId('finding-row')).toHaveCount(3);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();
  await expect.poll(() => requestedUrl).toContain('min-age-days=5');

  await page.screenshot({ path: 'test-results/aging-saved-view-full.png', fullPage: true });
});

/**
 * 86e37r2t7 AC4: proves the real, built app renders /discrepancies with
 * both the carrier and category presets applied when reached via the
 * "Estes accessorials" saved view -- same URL/request-wiring proof as
 * above, both filters combined.
 */
test('86e37r2t7 AC4: the "Estes accessorials" saved view navigates to /#/discrepancies?carrier=Estes&category=accessorial and requests both filters', async ({ page }) => {
  let requestedUrl = '';
  await page.route('**/api/findings**', (route) => {
    requestedUrl = route.request().url();
    return route.fulfill({ json: { findings: ROWS } });
  });
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Estes accessorials').click();

  await expect(page).toHaveURL(/\/#\/discrepancies\?carrier=Estes&category=accessorial$/);
  await expect(page.getByTestId('finding-row')).toHaveCount(3);
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();
  await expect.poll(() => requestedUrl).toContain('carrier=Estes');
  await expect.poll(() => requestedUrl).toContain('category=accessorial');

  await page.screenshot({ path: 'test-results/estes-saved-view-full.png', fullPage: true });
});

test('analyst reviews an extraction abstention and records its answer source', async ({ page }) => {
  const documentId = '44444444-4444-4444-8444-444444444444';
  const questionId = '33333333-3333-4333-8333-333333333333';
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));
  await page.route('**/api/clarifying-questions?**', (route) => route.fulfill({ json: { questions: [{
    id: questionId, source_document_id: documentId, field_path: 'contract.currency',
    question: 'Which currency applies?', answer: null, answer_source: null, abstention_status: 'NOT_FOUND',
    abstention_reason: 'MISSING_REQUIRED_FIELD', policy_version: 'abstention/1', question_hash: 'a'.repeat(64),
    created_at: '2026-08-27T00:00:00Z',
  }] } }));
  let submitted: unknown;
  await page.route(`**/api/clarifying-questions/${questionId}/answer`, async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { id: questionId, answer: 'USD', answer_source: 'carrier_confirmed', changed: true } });
  });

  await page.goto('/');
  await page.getByLabel('Source document ID').fill(documentId);
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('Which currency applies?')).toBeVisible();
  await page.getByRole('textbox', { name: 'Answer', exact: true }).fill('USD');
  await page.getByLabel('Answer source for contract.currency').selectOption('carrier_confirmed');
  await page.getByRole('button', { name: 'Save answer' }).click();

  await expect(page.getByText('1 of 1 answered')).toBeVisible();
  await expect(page.getByText('Answered · Carrier confirmed')).toBeVisible();
  expect(submitted).toEqual({ answer: 'USD', answer_source: 'carrier_confirmed' });
  await page.screenshot({ path: 'test-results/extraction-review-answered.png', fullPage: true });
});

/**
 * 86e387gmj gap3: each sub-page's own loading/error UI (RTL-tested via
 * *.test.tsx, never hit by Playwright before this) -- a gated route holds
 * the fetch open long enough to observe the real loading testid, then
 * resolves it as a 500 to prove the distinct error testid, mirroring the
 * home Dashboard's own page.route(..., () => route.fulfill({ status: 500 }))
 * pattern one level down. findings/summary are mocked in every case (same
 * convention as the existing /discrepancies /invoices /audit-log render
 * tests above) since Dashboard's own top-level fetch runs unconditionally
 * regardless of route.
 */
test('86e387gmj gap3: /discrepancies shows its loading state, then its own distinct error state on fetch failure', async ({ page }) => {
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  await page.route('**/api/findings**', async (route) => {
    await gate;
    return route.fulfill({ status: 500, body: '' });
  });

  await page.goto('/#/discrepancies');
  await expect(page.getByTestId('discrepancies-loading')).toBeVisible();

  resolveGate!();
  await expect(page.getByTestId('discrepancies-error')).toBeVisible();
  await expect(page.getByTestId('discrepancies-loading')).not.toBeVisible();
});

test('86e387gmj gap3: /invoices shows its loading state, then its own distinct error state on fetch failure', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  await page.route('**/api/invoices**', async (route) => {
    await gate;
    return route.fulfill({ status: 500, body: '' });
  });

  await page.goto('/#/invoices');
  await expect(page.getByTestId('invoices-loading')).toBeVisible();

  resolveGate!();
  await expect(page.getByTestId('invoices-error')).toBeVisible();
  await expect(page.getByTestId('invoices-loading')).not.toBeVisible();
});

test('86e387gmj gap3: /audit-log shows its loading state, then its own distinct error state on fetch failure', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  await page.route('**/api/internal/audit-log**', async (route) => {
    await gate;
    return route.fulfill({ status: 500, body: '' });
  });

  await page.goto('/#/audit-log');
  await expect(page.getByTestId('audit-log-loading')).toBeVisible();

  resolveGate!();
  await expect(page.getByTestId('audit-log-error')).toBeVisible();
  await expect(page.getByTestId('audit-log-loading')).not.toBeVisible();
});

/**
 * 86e387gmj gap3: Settings has no load-error state (fetchBranding() fails
 * closed to UNBRANDED rather than rejecting -- see SettingsView.tsx's own
 * header comment), so its real failure surface is a save error: the PATCH
 * to /api/internal/branding failing after a valid edit, distinct from the
 * GET-failure pattern the other three sub-pages use. Still proves the
 * loading testid first, same as the other three.
 */
test('86e387gmj gap3: /settings shows its loading state, then a save-failure error when the branding PATCH fails', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  await page.route('**/api/branding', async (route) => {
    await gate;
    return route.fulfill({ json: { branded: true, logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: null } });
  });
  await page.route('**/api/internal/branding', (route) => route.fulfill({ status: 500, body: '' }));

  await page.goto('/#/settings');
  await expect(page.getByTestId('settings-loading')).toBeVisible();

  resolveGate!();
  await expect(page.getByLabel('Primary color')).toHaveValue('#112233');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('settings-save-error')).toBeVisible();
});

/**
 * 86e387gmj gap4: closes 86e37r2t8's own self-flagged uncertainty ("not
 * verified beyond the e2e/screenshot's default viewport") -- the identical
 * assign-to-me -> Unassign flow, at a narrow (375px) viewport, proving the
 * Assignee column and its action button still work there. FindingsTable.tsx's
 * grid has no responsive column-hiding class -- at 375px the row's fixed-width
 * columns (~984px) overflow the sidebar-narrowed content area, so the
 * Assignee column is reached by horizontal scroll, not by fitting on-screen.
 * That's the same desktop-first, horizontally-scrollable-table pattern this
 * component already uses at any width (no mobile redesign is in this item's
 * scope -- No-gos: test-only). Viewport height is taller than a real phone's
 * (375x1400, not 375x800): Dashboard's home route stacks several analyst
 * panels above FindingsTable, and a short viewport squeezes FindingsTable's
 * own flex-1 box down to a sliver where even a scrolled-into-view row is
 * still vertically clipped by its overflow-hidden ancestor -- confirmed by
 * comparing elementFromPoint at both heights during investigation. 375x1400
 * isolates the width-only behavior this gap is actually about; a real user
 * would scroll the page down first, same effect. explicit
 * scrollIntoViewIfNeeded() (rather than relying on click()'s own
 * auto-scroll) is what actually moves the container's scrollLeft here.
 */
test('86e387gmj gap4: assigning a finding to self still works at a narrow (375px) viewport, reached via horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 1400 });

  let assignedToUserId: string | null = null;
  await page.route('**/api/findings**', (route) => {
    const withAssignee = ROWS.map((r) => (r.id === 'f1' ? { ...r, assignedToUserId } : r));
    return route.fulfill({ json: { findings: withAssignee } });
  });
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));
  await page.route('**/api/findings/f1/assign', (route) => {
    const body = route.request().postDataJSON() as { userId: string | null };
    assignedToUserId = body.userId === null ? null : 'user-1';
    return route.fulfill({ json: { assignedToUserId } });
  });

  await page.goto('/');
  await expect(page.getByTestId('finding-row')).toHaveCount(3);

  const firstRow = page.getByTestId('finding-row').first();
  const assignButton = firstRow.getByText('Assign to me');
  await assignButton.scrollIntoViewIfNeeded();
  await expect(assignButton).toBeVisible();
  await assignButton.click();

  await expect(firstRow.getByText('Unassign')).toBeVisible();

  await page.screenshot({ path: 'test-results/narrow-viewport-assign.png', fullPage: true });
});

/**
 * 86e387gmj gap5: Header.tsx's search/Export/New-audit-run controls are
 * real disabled form elements (86e2uv1r6), previously asserted only via RTL
 * (Dashboard.test.tsx AC1-AC3) -- toBeDisabled() only passes on a true
 * `disabled` attribute, which is the whole point of proving it in a real
 * browser rather than jsdom.
 */
test('86e387gmj gap5: the header search input, Export, and New audit run controls are really disabled in a real browser', async ({ page }) => {
  await page.route('**/api/findings**', (route) => route.fulfill({ json: { findings: ROWS } }));
  await page.route('**/api/findings/summary', (route) => route.fulfill({ json: SUMMARY }));

  await page.goto('/');

  await expect(page.getByPlaceholder('Search invoice, PRO, or claim ID')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New audit run' })).toBeDisabled();
});
