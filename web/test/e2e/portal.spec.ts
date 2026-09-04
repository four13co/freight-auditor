import { test, expect } from '@playwright/test';

/**
 * 86e34cfpd: real-page e2e coverage for the 10 client-portal views now that
 * PortalApp.tsx wires them into real routes. Every request is route-
 * intercepted (mock at the outermost boundary, per this item's own Rabbit
 * holes) -- deterministic, no live backend needed, same pattern as
 * dashboard.spec.ts's own auth mocks.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) => route.fulfill({
    json: { user: { id: 'client-user-1', email: 'client@example.com', name: 'Chris Client' }, session: { id: 'session-1' } },
  }));
  await page.route('**/api/auth/memberships', (route) => route.fulfill({
    json: { clientIds: ['11111111-1111-1111-1111-111111111111'], isInternal: false, role: 'client_viewer' },
  }));
});

/**
 * AC1: covers all 10 named views in one parameterized pass. Nine of them
 * render their own container the moment their route mounts (a nullable-id
 * view's own "not selected" state is still that view's real content, not
 * ComingSoon); ClientScorecardView takes a required auditRunId prop, so it
 * only mounts once the Invoices section's id picker is used -- exercised
 * inline below rather than as a separate case. No portal-data endpoints are
 * mocked here: every one of the 10 views renders its own container/section
 * regardless of load/error state, so AC1 needs only that the container
 * exists, not that it loaded real data (AC2/AC3 below cover loaded content).
 */
test('AC1: all 10 client-portal views are reachable via real portal routes, not ComingSoon', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByTestId('client-invoices-view')).toBeVisible();
  await expect(page.getByTestId('client-scorecard-not-selected')).toBeVisible();
  await page.getByLabel('Audit run ID').fill('run-1');
  await page.getByTestId('portal-scorecard-picker').getByRole('button', { name: 'View' }).click();
  await expect(page.getByTestId('client-scorecard-view')).toBeVisible();

  await page.getByRole('link', { name: 'Findings' }).click();
  await expect(page.getByTestId('client-findings-view')).toBeVisible();
  await expect(page.getByTestId('client-finding-evidence-view')).toBeVisible();

  await page.getByRole('link', { name: 'Disputes' }).click();
  await expect(page.getByTestId('client-dispute-detail-view')).toBeVisible();
  await expect(page.getByTestId('client-dispute-communications-view')).toBeVisible();

  await page.getByRole('link', { name: 'Claims & Recovery' }).click();
  await expect(page.getByTestId('client-claim-view')).toBeVisible();
  await expect(page.getByTestId('client-claim-documents-view')).toBeVisible();
  await expect(page.getByTestId('client-recovery-report')).toBeVisible();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByTestId('client-audit-log-view')).toBeVisible();

  await expect(page.getByTestId('portal-placeholder')).not.toBeVisible();
});

/**
 * AC2 (86e2zfjx3 AC4, satisfied via Playwright per this item's Source): a
 * user selects a dispute and, once it finishes loading, focus moves to the
 * newly-rendered detail content. Starts from the route's own genuine
 * "not selected" mount (never a deep link straight to a non-null id) so
 * useFocusOnReady's wasReady-starts-false guard sees a real transition, the
 * same precondition ClientDisputeDetailView.test.tsx's own RTL version of
 * this assertion relies on.
 */
test('AC2: selecting a dispute moves focus to its newly-rendered detail content', async ({ page }) => {
  await page.route('**/api/portal/disputes/d-1', (route) => route.fulfill({
    json: {
      id: 'd-1', carrierId: 'car-1', status: 'draft', amountClaimed: '500.0000', currency: 'USD',
      createdAt: '2026-01-15T00:00:00Z', lines: [],
    },
  }));

  await page.goto('/#/disputes');
  await expect(page.getByTestId('client-dispute-detail-empty')).toBeVisible();

  await page.getByLabel('Dispute ID').fill('d-1');
  await page.getByTestId('portal-dispute-picker').getByRole('button', { name: 'View' }).click();

  const content = page.getByTestId('client-dispute-detail-content');
  await expect(content).toBeVisible();
  await expect(content).toBeFocused();
});

/**
 * AC3 (86e2zfjx3 AC5, satisfied via Playwright per this item's Source): the
 * live region persists as the SAME DOM node across a page change (proven
 * via element-handle identity, not just testid re-query -- a live region
 * that unmounts/remounts never announces to a screen reader even if a
 * testid with the same string reappears) while its announced content
 * updates to the new page's data.
 */
test('AC3: audit log pagination keeps the same live-region node and updates its content', async ({ page }) => {
  const page1Events = Array.from({ length: 50 }, (_, i) => ({
    id: `evt-p1-${i}`, entity: 'invoice', entityId: null, event: 'created', actorKind: 'analyst',
    recordedAt: '2026-01-01T00:00:00Z',
  }));
  const page2Events = [
    { id: 'evt-p2-0', entity: 'dispute', entityId: null, event: 'opened', actorKind: 'client_admin', recordedAt: '2026-01-02T00:00:00Z' },
  ];

  await page.route('**/api/portal/audit-log?limit=50&offset=0', (route) => route.fulfill({ json: { events: page1Events } }));
  await page.route('**/api/portal/audit-log?limit=50&offset=50', (route) => route.fulfill({ json: { events: page2Events } }));

  await page.goto('/#/audit-log');
  await expect(page.getByTestId('client-audit-log-row')).toHaveCount(50);

  const liveRegion = page.getByTestId('client-audit-log-live-region');
  const beforeHandle = await liveRegion.elementHandle();

  await page.getByTestId('client-audit-log-next').click();

  await expect(page.getByTestId('client-audit-log-row')).toHaveCount(1);
  await expect(page.getByTestId('client-audit-log-actor-kind').first()).toHaveText('client_admin');

  const afterHandle = await liveRegion.elementHandle();
  expect(await page.evaluate(([a, b]) => a === b, [beforeHandle, afterHandle])).toBe(true);
});
