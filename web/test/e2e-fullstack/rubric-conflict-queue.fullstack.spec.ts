import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { persistTightenConflict } from '../../../src/modules/rubric-resolver/persist-tighten-conflict.js';

// 86e33qz95: full-stack e2e for RubricConflictQueue.tsx -- real Fastify
// server + real Postgres, no route mocking.
//
// RubricConflictQueue.tsx is a real, reachable, read-only display (confirmed
// via read: it renders resolution_conflict rows straight through, no
// pagination cap). Its "resolve" half is the genuine no-surface-exists case
// per this task's own reshape note: resolution_conflict has only an INSERT
// path (persistTightenConflict) -- no UPDATE/DELETE anywhere in src/, and no
// resolve endpoint exists (GET /api/rubric-conflicts is the only route
// touching this table). The resolve AC was dropped at reshape time rather
// than guessed at; this spec covers the one real AC that remains.
//
// The conflict is seeded via persistTightenConflict itself (the real,
// production write path -- P6.A's monotonic-tighten guard calls this when a
// rubric-tightening attempt fails its proof), called in-process per this
// task's own Rabbit holes ("reuse fixtures/helpers from [P2.A]/[P3.C]'s
// existing DB-level tests" -- test/db/persist-tighten-conflict.db.test.ts is
// that existing DB-level test, and this spec mirrors its exact input shape
// rather than inventing a new one), matching the "seed the non-HTTP
// precondition directly, drive/verify the real transition over the real UI"
// pattern already established across P7.A.3-P7.B.3.

const CRITERION_KEY = `P7B4.TEST.${Date.now()}`;

let pool: pg.Pool;
let conflictId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
    const written = await persistTightenConflict(client, {
      tenantId: DEV_CLIENT_ID,
      criterionKey: CRITERION_KEY,
      baseRuleVersionId: randomUUID(),
      attemptedRuleVersionId: randomUUID(),
      proof: { monotonic: false, reason: 'BOUND_WEAKENED' },
    });
    conflictId = written.id;
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM resolution_conflict WHERE id = $1`, [conflictId]);
  await pool.end();
});

test('AC1: a seeded rubric conflict appears in the Rubric Conflict Queue with its criterion, conflict type, and reason visible', async ({ page }) => {
  await page.goto('/');

  const queue = page.getByTestId('rubric-conflict-queue');
  await expect(queue).toBeVisible();
  // RubricConflictQueue.tsx renders exactly: criterion_key (or 'Global'),
  // conflict_type, and detail.reason (falling back to reasonCode, then
  // 'Review required') -- not a full versions-comparison view, per this
  // task's own AC text correcting the original overreach.
  await expect(queue).toContainText(CRITERION_KEY);
  await expect(queue).toContainText('NON_MONOTONE_TIGHTEN');
  await expect(queue).toContainText('BOUND_WEAKENED');
});
