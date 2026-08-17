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

  describe('job timeouts (86e2v1qrn)', () => {
    // This workflow has no concurrency group, so a hang here doesn't block
    // other runs the way deploy.yml's did -- still bounded rather than
    // relying on GitHub's 6h default, per the item's own AC to verify
    // (not assume) whether this workflow needed the same treatment.
    it.each(['db-tests', 'lint', 'typecheck', 'web', 'web-fullstack'])(
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
