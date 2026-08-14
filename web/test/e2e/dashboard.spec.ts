import { test, expect } from '@playwright/test';

const SUMMARY = {
  recoverableOpen: '148320.0000',
  flaggedToday: 42,
  withCarriers: 27,
  recoveredLast30Days: '96411.0000',
};

const ROWS = [
  {
    id: 'f1',
    invoiceNumber: 'INV-90385',
    carrierName: 'Saia LTL',
    billed: '1876.4000',
    expected: '0.0000',
    varianceAmount: '1876.4000',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'f2',
    invoiceNumber: 'INV-90408',
    carrierName: 'Old Dominion',
    billed: '5940.2000',
    expected: '5118.6000',
    varianceAmount: '821.6000',
    direction: 'OVERCHARGE',
    status: 'in_review',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'f3',
    invoiceNumber: 'INV-90331',
    carrierName: 'XPO Logistics',
    billed: '2077.3000',
    expected: null,
    varianceAmount: null,
    direction: 'INTEGRITY_ONLY',
    status: 'open',
    createdAt: new Date().toISOString(),
  },
];

/**
 * Renders the real dashboard page (Principle 1/7: a render test is part of
 * the contract for any UI change) with both API endpoints route-intercepted
 * -- deterministic, no live backend needed. This surface is in-design (not
 * blessed), so this is a perceptual-only capture: no toHaveScreenshot
 * baseline committed.
 */
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
