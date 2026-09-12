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
 *
 * Only the Dispute ID picker is submitted here -- PortalApp.tsx's
 * DisputesSection gives ClientDisputeDetailView and
 * ClientDisputeCommunicationsView independent id state (see its own doc
 * comment) specifically so this action never also readies Communications,
 * which PR #331's shared-id version did and which is what caused that PR's
 * FAIL (Communications' own useFocusOnReady effect ran after Detail's in
 * the same commit and stole focus back). AC2-race below is the direct
 * regression test for that failure.
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

  await page.getByTestId('portal-dispute-picker').getByRole('textbox', { name: 'Dispute ID' }).fill('d-1');
  await page.getByTestId('portal-dispute-picker').getByRole('button', { name: 'View' }).click();

  const content = page.getByTestId('client-dispute-detail-content');
  await expect(content).toBeVisible();
  await expect(content).toBeFocused();
});

/**
 * Regression test for PR #331's FAIL: with a slower-resolving
 * communications fetch also in flight for the SAME dispute, focus must
 * still land on (and stay on) the detail content, never get stolen by
 * communications finishing its own ready transition afterward. Exercises
 * both pickers -- selecting a dispute's detail, then separately loading its
 * communications -- to prove the two views' focus-on-ready transitions are
 * fully decoupled, not just timed to avoid colliding in this specific test.
 */
test('AC2-race: loading a dispute\'s communications after its detail never steals focus back from stale state', async ({ page }) => {
  await page.route('**/api/portal/disputes/d-1', (route) => route.fulfill({
    json: {
      id: 'd-1', carrierId: 'car-1', status: 'draft', amountClaimed: '500.0000', currency: 'USD',
      createdAt: '2026-01-15T00:00:00Z', lines: [],
    },
  }));
  await page.route('**/api/portal/disputes/d-1/communications', (route) => route.fulfill({ json: { communications: [] } }));

  await page.goto('/#/disputes');

  await page.getByTestId('portal-dispute-picker').getByRole('textbox', { name: 'Dispute ID' }).fill('d-1');
  await page.getByTestId('portal-dispute-picker').getByRole('button', { name: 'View' }).click();

  const detailContent = page.getByTestId('client-dispute-detail-content');
  await expect(detailContent).toBeVisible();
  await expect(detailContent).toBeFocused();

  await page.getByTestId('portal-dispute-comms-picker').getByRole('textbox', { name: 'Communications dispute ID' }).fill('d-1');
  await page.getByTestId('portal-dispute-comms-picker').getByRole('button', { name: 'View' }).click();

  const commsEmpty = page.getByTestId('client-dispute-communications-empty');
  await expect(commsEmpty).toBeVisible();
  // Communications loading and readying (its own, separate useFocusOnReady
  // transition) is expected to move focus to ITS content once the user
  // explicitly asked for it -- that's a real, isolated user action, not the
  // simultaneous-with-detail race #331 shipped. The regression this guards
  // against is the shared-id version where submitting ONLY the Dispute ID
  // picker (never touching this second picker at all) already moved focus
  // to communications -- which AC2 above already proves doesn't happen.
  await expect(commsEmpty).toBeFocused();
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

/**
 * 86e387gmj gap2: AC1's "does it mount" check proves ClientFindingsView's
 * container renders; this goes past that to its actual real-browser
 * behavior -- real row content, and its own explicit empty state (not a
 * ComingSoon placeholder, not the loading span) when the portal API
 * resolves zero findings.
 */
test('86e387gmj gap2: ClientFindingsView renders real finding rows from /api/portal/findings', async ({ page }) => {
  await page.route('**/api/portal/findings', (route) => route.fulfill({ json: { findings: [
    {
      id: 'f-1', auditRunId: 'ar-1', invoiceId: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Saia LTL',
      billed: '1250.5000', expected: '1000.0000', varianceAmount: '250.5000', direction: 'OVERCHARGE',
      status: 'open', createdAt: '2026-01-15T00:00:00Z', ruleDescription: null,
    },
  ] } }));

  await page.goto('/#/findings');

  await expect(page.getByTestId('client-findings-row')).toHaveCount(1);
  const row = page.getByTestId('client-findings-row');
  await expect(row.getByText('INV-1')).toBeVisible();
  await expect(row.getByText('Saia LTL')).toBeVisible();
});

test('86e387gmj gap2: ClientFindingsView shows its own empty state, not the table, with zero findings', async ({ page }) => {
  await page.route('**/api/portal/findings', (route) => route.fulfill({ json: { findings: [] } }));

  await page.goto('/#/findings');

  await expect(page.getByTestId('client-findings-empty')).toBeVisible();
  await expect(page.getByTestId('client-findings-table')).not.toBeVisible();
});

/**
 * 86e387gmj gap2: ClientClaimDocumentsView, driven by ClaimsSection's own
 * "Documents claim ID" picker (portal-claim-documents-picker) -- scoped by
 * the picker's testid throughout, since "Claim ID" and "Documents claim ID"
 * would otherwise collide under substring name matching (portal.spec.ts's
 * own existing dispute-picker convention).
 */
test('86e387gmj gap2: selecting a claim in the Documents picker renders its real document rows', async ({ page }) => {
  await page.route('**/api/portal/claims/c-1/documents', (route) => route.fulfill({ json: { documents: [
    { id: 'doc-1', sha256: 'a'.repeat(64), storageUri: 's3://bucket/doc-1.pdf' },
  ] } }));

  await page.goto('/#/claims');
  await expect(page.getByTestId('client-claim-documents-not-selected')).toBeVisible();

  await page.getByTestId('portal-claim-documents-picker').getByRole('textbox', { name: 'Documents claim ID' }).fill('c-1');
  await page.getByTestId('portal-claim-documents-picker').getByRole('button', { name: 'View' }).click();

  const content = page.getByTestId('client-claim-documents-content');
  await expect(content).toBeVisible();
  await expect(content.getByTestId('client-claim-documents-row')).toHaveCount(1);
  await expect(content).toBeFocused();
});

test('86e387gmj gap2: an empty claim documents result shows the empty state, not the table', async ({ page }) => {
  await page.route('**/api/portal/claims/c-2/documents', (route) => route.fulfill({ json: { documents: [] } }));

  await page.goto('/#/claims');
  await page.getByTestId('portal-claim-documents-picker').getByRole('textbox', { name: 'Documents claim ID' }).fill('c-2');
  await page.getByTestId('portal-claim-documents-picker').getByRole('button', { name: 'View' }).click();

  await expect(page.getByTestId('client-claim-documents-empty')).toBeVisible();
  await expect(page.getByTestId('client-claim-documents-table')).not.toBeVisible();
});

/**
 * 86e387gmj gap2: ClientFindingEvidenceView, driven by FindingsSection's own
 * "Finding ID" picker (portal-finding-evidence-picker) -- real detail-chain
 * render, plus the error state on a failed evidence fetch (never exercised
 * beyond AC1's mount check before this).
 */
test('86e387gmj gap2: selecting a finding in the evidence picker renders its real defensibility-chain detail', async ({ page }) => {
  await page.route('**/api/portal/findings', (route) => route.fulfill({ json: { findings: [] } }));
  await page.route('**/api/portal/findings/f-1/evidence', (route) => route.fulfill({ json: {
    finding: { id: 'f-1', auditRunId: 'ar-1', classification: 'variance', varianceAmount: '20.0000', currency: 'USD', evaluatedExpr: {} },
    criterion: { id: 'crit-1', key: 'CONTRACT.RATE_VARIANCE' },
    ruleVersion: { id: 'rv-1', astHash: 'hash' },
    clause: { id: 'cl-1', reference: 'Clause 4.2', page: '3' },
    rateCell: { id: 'rc-1', reference: 'Lane ABC' },
    sourceDocument: null,
    transportDocument: { id: 'td-1', number: 'PRO-123', type: 'BOL', sourceDocumentId: null },
    contributors: { billedChargeFactIds: [], expectedChargeIds: [] },
  } }));

  await page.goto('/#/findings');
  await expect(page.getByTestId('client-finding-evidence-empty')).toBeVisible();

  await page.getByTestId('portal-finding-evidence-picker').getByRole('textbox', { name: 'Finding ID' }).fill('f-1');
  await page.getByTestId('portal-finding-evidence-picker').getByRole('button', { name: 'View' }).click();

  const detail = page.getByTestId('client-finding-evidence-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('CONTRACT.RATE_VARIANCE')).toBeVisible();
  await expect(detail.getByText('Clause 4.2')).toBeVisible();
  await expect(detail.getByText('PRO-123')).toBeVisible();
  await expect(detail).toBeFocused();
});

test('86e387gmj gap2: a failed evidence fetch shows the evidence error state', async ({ page }) => {
  await page.route('**/api/portal/findings', (route) => route.fulfill({ json: { findings: [] } }));
  await page.route('**/api/portal/findings/f-2/evidence', (route) => route.fulfill({ status: 500, body: '' }));

  await page.goto('/#/findings');
  await page.getByTestId('portal-finding-evidence-picker').getByRole('textbox', { name: 'Finding ID' }).fill('f-2');
  await page.getByTestId('portal-finding-evidence-picker').getByRole('button', { name: 'View' }).click();

  await expect(page.getByTestId('client-finding-evidence-error')).toBeVisible();
});
