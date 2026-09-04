import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRlsGuard,
  checkMonitoringWired,
  checkBackupsDocumented,
  checkOnCallDocumented,
  runLaunchReadinessCheck,
  RLS_GUARD_TEST_PATH,
  DEPLOY_WORKFLOW_TEST_PATH,
  DEPLOY_WORKFLOW_TEST_FILTER,
  BACKUPS_STATUS_LABEL,
} from '../../scripts/launch-readiness-check.mjs';

// 86e2zfk30: client launch-readiness gate, four items. Each test below maps
// 1:1 to one of the task's stated Given/When/Then acceptance criteria.

const PASSING_RUN_RESULT = { stdout: 'Tests  1 passed (1)\n', stderr: '' };

function writeFixtureDocs(dir: string, { backupsStatus = 'CONFIRMED' }: { backupsStatus?: string } = {}): void {
  mkdirSync(join(dir, 'docs/runbooks'), { recursive: true });
  writeFileSync(
    join(dir, 'docs/runbooks/backup-restore.md'),
    `## Current status\n\n${BACKUPS_STATUS_LABEL} ${backupsStatus}\n\n## Automated backups\n\nyes\n\n## Restore procedure\n\nyes\n`,
  );
  writeFileSync(join(dir, 'docs/runbooks/on-call.md'), '## Who responds\n\nsomeone\n\n## Where to look first\n\nsomewhere\n');
}

describe('checkRlsGuard (AC1 -- RLS reports pass by invoking the existing guard, not a new implementation)', () => {
  it('invokes exactly the existing schema-wide FORCE RLS guard test, not a reimplementation', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    await checkRlsGuard({ runImpl });
    expect(runImpl).toHaveBeenCalledWith('npx', ['vitest', 'run', '--config', 'vitest.db.config.ts', RLS_GUARD_TEST_PATH]);
  });

  it('given the guard test passes, reports pass for item 1', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    const result = await checkRlsGuard({ runImpl });
    expect(result.pass).toBe(true);
  });

  it('given the guard test fails, reports fail for item 1 (not a silent pass)', async () => {
    const runImpl = vi.fn().mockRejectedValue(new Error('1 failed | 0 passed'));
    const result = await checkRlsGuard({ runImpl });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('failed');
  });

  // Every test above stubs runImpl -- proving the invocation target and the
  // exit-code-to-pass mapping, not that the guard truly runs. The real,
  // non-stubbed invocation was verified live against a fresh ephemeral DB
  // (`npm run launch-readiness` -> "[PASS] rls: invoked
  // test/db/tenant-rls-schema-guard.db.test.ts -- passed"); see the PR body.
});

describe('checkMonitoringWired (AC3 -- confirms /health is polled and a failure triggers rollback)', () => {
  it('invokes the existing deploy-workflow test suite\'s post-deployment health-check + rollback coverage, not a re-parse of deploy.yml', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    await checkMonitoringWired({ runImpl });
    expect(runImpl).toHaveBeenCalledWith('npx', ['vitest', 'run', DEPLOY_WORKFLOW_TEST_PATH, '-t', DEPLOY_WORKFLOW_TEST_FILTER]);
  });

  it('given that suite passes, confirms something real polls /ready-adjacent health and reports pass', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    const result = await checkMonitoringWired({ runImpl });
    expect(result.pass).toBe(true);
  });

  it('given that suite fails, reports fail rather than silently passing', async () => {
    const runImpl = vi.fn().mockRejectedValue(new Error('2 failed | 5 passed'));
    const result = await checkMonitoringWired({ runImpl });
    expect(result.pass).toBe(false);
  });

  it('given the -t filter matches zero tests (exit 0, stale filter), reports fail rather than passing having verified nothing', async () => {
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'No test files found\nTests  0 passed (0)\n', stderr: '' });
    const result = await checkMonitoringWired({ runImpl });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('matched no tests');
  });
});

describe('checkBackupsDocumented (AC2 -- a documented restore procedure is confirmed present)', () => {
  it('given the real backup-restore runbook, reports fail because production has no database provisioned yet (status: NOT CONFIGURED)', () => {
    // This is the honest current state, not a test gap: 86e2zfk30's own
    // deploy.yml comments confirm production has no DATABASE_URL secret.
    // A gate that greenlights client onboarding against a non-existent
    // production database would be worse than no gate.
    const result = checkBackupsDocumented();
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('NOT CONFIGURED');
  });

  it('given a fixture doc whose status line reads CONFIRMED, reports pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      writeFixtureDocs(dir, { backupsStatus: 'CONFIRMED' });
      const result = checkBackupsDocumented({ docsRoot: dir });
      expect(result.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('given no runbook exists, reports fail rather than assuming backups are configured', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      const result = checkBackupsDocumented({ docsRoot: emptyDir });
      expect(result.pass).toBe(false);
      expect(result.detail).toContain('does not exist');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('given a runbook missing the restore-procedure section, reports fail rather than a partial pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      mkdirSync(join(dir, 'docs/runbooks'), { recursive: true });
      writeFileSync(join(dir, 'docs/runbooks/backup-restore.md'), '## Automated backups\n\nyes\n');
      const result = checkBackupsDocumented({ docsRoot: dir });
      expect(result.pass).toBe(false);
      expect(result.detail).toContain('Restore procedure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('given headings present but no status line, reports fail naming the missing marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      mkdirSync(join(dir, 'docs/runbooks'), { recursive: true });
      writeFileSync(join(dir, 'docs/runbooks/backup-restore.md'), '## Automated backups\n\nyes\n\n## Restore procedure\n\nyes\n');
      const result = checkBackupsDocumented({ docsRoot: dir });
      expect(result.pass).toBe(false);
      expect(result.detail).toContain(BACKUPS_STATUS_LABEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkOnCallDocumented (AC4 -- a short on-call doc naming a responder and where to look first is confirmed present)', () => {
  it('given the real on-call runbook, confirms it names a responder and where to look first', () => {
    const result = checkOnCallDocumented();
    expect(result.pass).toBe(true);
  });

  it('given no on-call doc exists, reports fail', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      const result = checkOnCallDocumented({ docsRoot: emptyDir });
      expect(result.pass).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('runLaunchReadinessCheck (Done when -- all four items wired/confirmed together)', () => {
  it('reports ready only when all four items genuinely pass', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    const dir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      writeFixtureDocs(dir, { backupsStatus: 'CONFIRMED' });
      const report = await runLaunchReadinessCheck({ runImpl, docsRoot: dir });
      expect(report.ready).toBe(true);
      expect(report.items.rls.pass).toBe(true);
      expect(report.items.backups.pass).toBe(true);
      expect(report.items.monitoring.pass).toBe(true);
      expect(report.items.onCall.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('against this repo\'s real docs today, reports NOT READY -- production has no database yet, so onboarding is not actually safe', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    const report = await runLaunchReadinessCheck({ runImpl });
    expect(report.ready).toBe(false);
    expect(report.items.backups.pass).toBe(false);
    expect(report.items.onCall.pass).toBe(true);
  });

  it('reports not-ready if any single item fails, without masking which one', async () => {
    const runImpl = vi.fn().mockResolvedValue(PASSING_RUN_RESULT);
    const emptyDir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
    try {
      const report = await runLaunchReadinessCheck({ runImpl, docsRoot: emptyDir });
      expect(report.ready).toBe(false);
      expect(report.items.rls.pass).toBe(true);
      expect(report.items.monitoring.pass).toBe(true);
      expect(report.items.backups.pass).toBe(false);
      expect(report.items.onCall.pass).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
