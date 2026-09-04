// 86e2zfk30: client launch-readiness gate. Four checks, each machine-checked
// against an artifact that already exists rather than reinvented -- items 1
// and 3 literally invoke the existing DB guard test and deploy-workflow unit
// suite (as subprocesses, same pattern rollback-deploy.mjs/post-deploy-healthcheck.mjs
// use for CapRover calls) instead of re-deriving their assertions; items 2 and
// 4 confirm the required runbook docs exist with the sections the task asks for.
//
// Deliberately NOT a generic pluggable "readiness framework" (the task's own
// Rabbit holes) -- four fixed checks, nothing extensible.

import { readFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RLS_GUARD_TEST_PATH = 'test/db/tenant-rls-schema-guard.db.test.ts';
export const DEPLOY_WORKFLOW_TEST_PATH = 'test/unit/deploy-workflow.test.ts';
// The task's own describe-block id, not its prose name: `-t` is a regex, and
// the prose ("post-deployment health-check + rollback") contains a literal
// `+` that vitest's -t parses as a quantifier rather than a literal
// character -- confirmed live, it silently matched zero tests (caught by
// atLeastOneTestPassed below, not by luck). The id has no regex
// metacharacters and is this codebase's own convention for a stable
// reference to a specific describe block.
export const DEPLOY_WORKFLOW_TEST_FILTER = '86e27d4rh';
export const BACKUP_RESTORE_DOC_PATH = 'docs/runbooks/backup-restore.md';
export const ON_CALL_DOC_PATH = 'docs/runbooks/on-call.md';
export const BACKUPS_STATUS_LABEL = 'Production backups status:';

const SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000;

/** @param {string} cmd @param {string[]} args */
export async function defaultRun(cmd, args) {
  const { execFile } = await import('node:child_process');
  return promisify(execFile)(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS });
}

/**
 * Item 1 (RLS): invokes the existing schema-wide FORCE RLS guard test
 * (test/db/tenant-rls-schema-guard.db.test.ts, from 86e2zfjrj / PR #271) as a
 * subprocess -- does not reimplement its SQL. Requires a live DATABASE_URL,
 * same as any `npm run test:db` invocation.
 *
 * @param {{ runImpl?: typeof defaultRun }} [opts]
 */
export async function checkRlsGuard({ runImpl = defaultRun } = {}) {
  try {
    await runImpl('npx', ['vitest', 'run', '--config', 'vitest.db.config.ts', RLS_GUARD_TEST_PATH]);
    return { pass: true, detail: `invoked ${RLS_GUARD_TEST_PATH} -- passed`, invokes: RLS_GUARD_TEST_PATH };
  } catch (err) {
    return {
      pass: false,
      detail: `invoked ${RLS_GUARD_TEST_PATH} -- failed: ${err instanceof Error ? err.message : String(err)}`,
      invokes: RLS_GUARD_TEST_PATH,
    };
  }
}

/**
 * `vitest run <file> -t "<filter>"` exits 0 and prints "Tests  0 passed" when
 * the filter matches nothing (e.g. the describe block was renamed) -- a
 * silent fail-open that would report this item PASS having verified nothing.
 * Requires the summary line to show at least one passed test.
 *
 * @param {string} stdout
 */
function atLeastOneTestPassed(stdout) {
  const match = /Tests\s+(\d+)\s+passed/.exec(stdout);
  return match !== null && Number(match[1]) >= 1;
}

/**
 * Item 3 (monitoring): invokes the existing deploy-workflow unit suite's
 * "post-deployment health-check + rollback" describe block, which already
 * proves GET /health is polled post-deploy and a failure triggers rollback --
 * does not re-parse deploy.yml itself. On notification: no dedicated
 * alerting channel is wired (documented in docs/runbooks/on-call.md);
 * GitHub's default workflow-failure notification is what pages a human today.
 *
 * @param {{ runImpl?: typeof defaultRun }} [opts]
 */
export async function checkMonitoringWired({ runImpl = defaultRun } = {}) {
  const label = `invoked ${DEPLOY_WORKFLOW_TEST_PATH} -t "${DEPLOY_WORKFLOW_TEST_FILTER}"`;
  try {
    const { stdout } = await runImpl('npx', ['vitest', 'run', DEPLOY_WORKFLOW_TEST_PATH, '-t', DEPLOY_WORKFLOW_TEST_FILTER]);
    if (!atLeastOneTestPassed(stdout)) {
      return {
        pass: false,
        detail: `${label} -- exited 0 but matched no tests (filter likely stale -- the describe block may have been renamed)`,
        invokes: DEPLOY_WORKFLOW_TEST_PATH,
      };
    }
    return { pass: true, detail: `${label} -- passed`, invokes: DEPLOY_WORKFLOW_TEST_PATH };
  } catch (err) {
    return {
      pass: false,
      detail: `${label} -- failed: ${err instanceof Error ? err.message : String(err)}`,
      invokes: DEPLOY_WORKFLOW_TEST_PATH,
    };
  }
}

/**
 * @param {string} relPath
 * @param {string[]} requiredHeadings
 * @param {string} docsRoot
 */
function checkDocHasHeadings(relPath, requiredHeadings, docsRoot) {
  const fullPath = join(docsRoot, relPath);
  if (!existsSync(fullPath)) {
    return { pass: false, detail: `${relPath} does not exist`, path: relPath };
  }
  const content = readFileSync(fullPath, 'utf8');
  const missing = requiredHeadings.filter((heading) => !content.includes(heading));
  if (missing.length > 0) {
    return { pass: false, detail: `${relPath} exists but is missing: ${missing.join(', ')}`, path: relPath };
  }
  return { pass: true, detail: `${relPath} exists and documents ${requiredHeadings.join(', ')}`, path: relPath };
}

/**
 * Item 2 (backups): confirms docs/runbooks/backup-restore.md exists,
 * documents both automated backups and a restore procedure, AND that its
 * `Production backups status:` line reads CONFIRMED -- not just that the
 * procedure is written down. A written procedure for a database that does
 * not yet exist is not "backups configured": the doc's own status line is
 * the single source of truth this check reads literally, so it fails
 * honestly (not silently passes) while production has no database
 * provisioned (see .github/workflows/deploy.yml).
 *
 * @param {{ docsRoot?: string }} [opts]
 */
export function checkBackupsDocumented({ docsRoot = REPO_ROOT } = {}) {
  const headingsResult = checkDocHasHeadings(BACKUP_RESTORE_DOC_PATH, ['## Automated backups', '## Restore procedure'], docsRoot);
  if (!headingsResult.pass) return headingsResult;

  const content = readFileSync(join(docsRoot, BACKUP_RESTORE_DOC_PATH), 'utf8');
  const statusMatch = new RegExp(`${BACKUPS_STATUS_LABEL}\\s*(.+)`).exec(content);
  if (statusMatch === null) {
    return {
      pass: false,
      detail: `${BACKUP_RESTORE_DOC_PATH} exists but has no "${BACKUPS_STATUS_LABEL}" line`,
      path: BACKUP_RESTORE_DOC_PATH,
    };
  }
  const status = statusMatch[1].trim().toUpperCase();
  if (status !== 'CONFIRMED') {
    return {
      pass: false,
      detail: `${BACKUP_RESTORE_DOC_PATH} reports production backups status: ${status} -- not CONFIRMED`,
      path: BACKUP_RESTORE_DOC_PATH,
    };
  }
  return { pass: true, detail: `${BACKUP_RESTORE_DOC_PATH} documents the restore procedure and confirms production backups status: CONFIRMED`, path: BACKUP_RESTORE_DOC_PATH };
}

/**
 * Item 4 (on-call): confirms docs/runbooks/on-call.md exists and names a
 * responder and where to look first.
 *
 * @param {{ docsRoot?: string }} [opts]
 */
export function checkOnCallDocumented({ docsRoot = REPO_ROOT } = {}) {
  return checkDocHasHeadings(ON_CALL_DOC_PATH, ['## Who responds', '## Where to look first'], docsRoot);
}

/**
 * Runs all four checks and returns the aggregate report. RLS and monitoring
 * run as real subprocesses by default (need a live DATABASE_URL for RLS);
 * inject runImpl to stub both in tests.
 *
 * @param {{ runImpl?: typeof defaultRun, docsRoot?: string }} [opts]
 */
export async function runLaunchReadinessCheck({ runImpl = defaultRun, docsRoot = REPO_ROOT } = {}) {
  const [rls, monitoring] = await Promise.all([
    checkRlsGuard({ runImpl }),
    checkMonitoringWired({ runImpl }),
  ]);
  const backups = checkBackupsDocumented({ docsRoot });
  const onCall = checkOnCallDocumented({ docsRoot });

  const items = { rls, backups, monitoring, onCall };
  const ready = Object.values(items).every((item) => item.pass);
  return { ready, items };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runLaunchReadinessCheck();
  for (const [name, result] of Object.entries(report.items)) {
    process.stdout.write(`[${result.pass ? 'PASS' : 'FAIL'}] ${name}: ${result.detail}\n`);
  }
  process.stdout.write(`\nlaunch-readiness: ${report.ready ? 'READY' : 'NOT READY'}\n`);
  process.exit(report.ready ? 0 : 1);
}
