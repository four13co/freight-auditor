import { test, expect } from '@playwright/test';
import { DASHBOARD_ROWS as ROWS, DASHBOARD_SUMMARY as SUMMARY } from '../fixtures.js';

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
  await page.getByLabel('Answer').fill('USD');
  await page.getByLabel('Answer source for contract.currency').selectOption('carrier_confirmed');
  await page.getByRole('button', { name: 'Save answer' }).click();

  await expect(page.getByText('1 of 1 answered')).toBeVisible();
  await expect(page.getByText('Answered · Carrier confirmed')).toBeVisible();
  expect(submitted).toEqual({ answer: 'USD', answer_source: 'carrier_confirmed' });
  await page.screenshot({ path: 'test-results/extraction-review-answered.png', fullPage: true });
});
