import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

interface WorkflowJob {
  services?: Record<string, { env?: Record<string, string> }>;
  env?: Record<string, unknown>;
  'timeout-minutes'?: number;
  steps: Array<{
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
  }>;
}

interface Workflow {
  on: { pull_request?: { branches: string[] }; push?: { branches: string[] } };
  jobs: Record<string, WorkflowJob>;
  concurrency?: unknown;
}

function loadCiWorkflow(): Workflow {
  const raw = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  return load(raw) as Workflow;
}

function getJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  if (!job) throw new Error(`expected job "${name}" to exist in ci.yml`);
  return job;
}

/**
 * 86e2uut65: ci.yml previously only triggered on pull_request, so every PR
 * was verified against its own branch state and the merged result deployed
 * untested. Adding `push` on Development re-runs the same jobs against the
 * actual merge commit -- the gate that would have caught PRs #51+#52
 * shipping a dashboard where every data call 401'd (each PR's own suite was
 * green in isolation; CI never ran them together).
 */
describe('ci.yml (unit, merge-commit trigger)', () => {
  it('AC1: also triggers on push to Development, not just pull_request', () => {
    const workflow = loadCiWorkflow();
    expect(workflow.on.pull_request?.branches).toEqual(['Development']);
    expect(workflow.on.push?.branches).toEqual(['Development']);
  });

  it('does not add a concurrency group -- deploy.yml already owns deploy-${{ github.ref }}, and this workflow does not need to serialize against it or itself', () => {
    const workflow = loadCiWorkflow();
    expect(workflow.concurrency).toBeUndefined();
  });

  it('all four pre-existing jobs (db-tests, lint, typecheck, web) still exist, so a merge-commit push re-runs them', () => {
    const workflow = loadCiWorkflow();
    for (const jobName of ['db-tests', 'lint', 'typecheck', 'web']) {
      expect(workflow.jobs[jobName], `expected job "${jobName}" to exist`).toBeDefined();
    }
  });

  it('the web-fullstack job (86e2uv4p0) also exists, so a merge-commit push exercises the full-stack contract too', () => {
    const workflow = loadCiWorkflow();
    expect(workflow.jobs['web-fullstack']).toBeDefined();
  });

  it('web-fullstack sources DATABASE_URL from its own hardcoded localhost service, not a repo-level secret that could point elsewhere on a push-triggered run', () => {
    const workflow = loadCiWorkflow();
    const job = getJob(workflow, 'web-fullstack');
    expect(job.env?.DATABASE_URL).toBe('postgresql://ci:ci@localhost:5432/ci');
    expect(job.services?.postgres).toBeDefined();
  });

  it("web-fullstack's Build web step sets VITE_DEV_AUTH_HEADERS=1 (86e2v1bdj) -- vite build bakes import.meta.env.DEV to false, so without this the built bundle sends no auth headers and every page-driven /api/* call 401s against this job's DEV_AUTH_HEADERS=1 server", () => {
    const workflow = loadCiWorkflow();
    const job = getJob(workflow, 'web-fullstack');
    const buildStep = job.steps.find((s) => s.run?.includes('npm --prefix web run build'));
    expect(buildStep).toBeDefined();
    expect(buildStep!.env?.VITE_DEV_AUTH_HEADERS).toBe('1');
  });

  describe('Playwright browser cache (86e2wb87v)', () => {
    // "Install Playwright browsers" hung/timed out 3x across PR
    // #99/#102/#103's CI runs, all self-resolved on plain rerun -- consistent
    // with a slow/rate-limited binary download. Caching the browser binary
    // dir means a cache hit skips that download; the install step must
    // still sit immediately after the cache step (not reordered away) and
    // the cache key must vary with the resolved Playwright version so a
    // version bump can't restore mismatched binaries.
    it.each(['web', 'web-fullstack'])(
      'job "%s" has a cache step for ~/.cache/ms-playwright immediately before "Install Playwright browsers"',
      (jobName) => {
        const workflow = loadCiWorkflow();
        const job = getJob(workflow, jobName);
        const installIndex = job.steps.findIndex((s) => s.name === 'Install Playwright browsers');
        expect(installIndex, `expected "${jobName}" to have an "Install Playwright browsers" step`).toBeGreaterThanOrEqual(0);

        const cacheStep = job.steps[installIndex - 1];
        expect(cacheStep, `expected a step immediately before "Install Playwright browsers" in "${jobName}"`).toBeDefined();
        expect(cacheStep!.uses).toMatch(/^actions\/cache@/);
      },
    );

    it.each(['web', 'web-fullstack'])(
      'job "%s" cache key includes the Playwright version (via package-lock.json) and runner OS/arch',
      (jobName) => {
        const workflow = loadCiWorkflow();
        const job = getJob(workflow, jobName);
        const installIndex = job.steps.findIndex((s) => s.name === 'Install Playwright browsers');
        const cacheStep = job.steps[installIndex - 1];
        expect(cacheStep, `expected a step immediately before "Install Playwright browsers" in "${jobName}"`).toBeDefined();
        expect(cacheStep!.with?.path).toBe('~/.cache/ms-playwright');
        expect(cacheStep!.with?.key).toContain("hashFiles('web/package-lock.json')");
        expect(cacheStep!.with?.key).toContain('runner.os');
        expect(cacheStep!.with?.key).toContain('runner.arch');
      },
    );
  });

  describe('web-fullstack-auth job (86e2vqggf)', () => {
    // This job exists specifically to exercise the path web-fullstack does
    // NOT (a real better-auth session, no DEV_AUTH_HEADERS) -- its defining
    // property is that its Build web step must NOT set
    // VITE_DEV_AUTH_HEADERS, unlike web-fullstack's identical-looking step.
    // A future edit accidentally copying that env block over would silently
    // turn this job back into a second copy of web-fullstack, so assert the
    // absence directly rather than only asserting the job exists.
    it('exists, with its own Postgres service and DATABASE_URL (same shape as web-fullstack)', () => {
      const workflow = loadCiWorkflow();
      const job = getJob(workflow, 'web-fullstack-auth');
      expect(job.services?.postgres).toBeDefined();
      expect(job.env?.DATABASE_URL).toBe('postgresql://ci:ci@localhost:5432/ci');
    });

    it('sets APP_URL and SESSION_SECRET at the job level so the seed step and the Playwright webServer agree', () => {
      const workflow = loadCiWorkflow();
      const job = getJob(workflow, 'web-fullstack-auth');
      expect(job.env?.APP_URL).toBeTruthy();
      expect(job.env?.SESSION_SECRET).toBeTruthy();
    });

    it("its Build web step does NOT set VITE_DEV_AUTH_HEADERS -- the whole point is the real login form renders instead of App.tsx's devHeaderPathActive() skipping it", () => {
      const workflow = loadCiWorkflow();
      const job = getJob(workflow, 'web-fullstack-auth');
      const buildStep = job.steps.find((s) => s.run?.includes('npm --prefix web run build'));
      expect(buildStep).toBeDefined();
      expect(buildStep!.env?.VITE_DEV_AUTH_HEADERS).toBeUndefined();
    });

    it('seeds the real-session auth user before the e2e run step (the seed must exist before Playwright starts signing in)', () => {
      const workflow = loadCiWorkflow();
      const job = getJob(workflow, 'web-fullstack-auth');
      const seedIndex = job.steps.findIndex((s) => s.run?.includes('npm run seed:e2e-auth-user'));
      const e2eIndex = job.steps.findIndex((s) => s.run?.includes('npm run web:e2e:fullstack-auth'));
      expect(seedIndex).toBeGreaterThanOrEqual(0);
      expect(e2eIndex).toBeGreaterThan(seedIndex);
    });
  });

  describe('job timeouts (86e2v1qrn)', () => {
    // This workflow has no concurrency group, so a hang here doesn't block
    // other runs the way deploy.yml's did -- still bounded rather than
    // relying on GitHub's 6h default, per the item's own AC to verify
    // (not assume) whether this workflow needed the same treatment.
    it.each(['db-tests', 'lint', 'typecheck', 'web', 'web-fullstack', 'web-fullstack-auth'])(
      'job "%s" declares an explicit timeout-minutes well below GitHub\'s 6h default',
      (jobName) => {
        const workflow = loadCiWorkflow();
        const timeout = getJob(workflow, jobName)['timeout-minutes'];
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThan(360);
      },
    );
  });
});
