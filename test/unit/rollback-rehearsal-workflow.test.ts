import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  'timeout-minutes'?: number;
  steps: Array<{
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    with?: Record<string, unknown>;
    env?: Record<string, unknown>;
    'timeout-minutes'?: number;
  }>;
}

interface Workflow {
  on: unknown;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): Workflow {
  const raw = readFileSync(new URL('../../.github/workflows/rollback-rehearsal.yml', import.meta.url), 'utf8');
  return load(raw) as Workflow;
}

function getJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  if (!job) throw new Error(`expected job "${name}" to exist in rollback-rehearsal.yml`);
  return job;
}

// 86e2v2h0e: rollbackToLastGood()'s real subprocess sequence has never once
// completed successfully live in production. This workflow rehearses it on
// demand -- these tests guard the wiring that makes the rehearsal actually
// exercise the real sequence (not a mocked one) while never risking a real
// deploy over the live app.
describe('rollback-rehearsal.yml (unit, job wiring)', () => {
  it('triggers only via workflow_dispatch -- no other trigger key present in the on: block', () => {
    // js-yaml parses the bare `on:` key as the boolean `true` unless quoted --
    // read the raw text instead of relying on the parsed key surviving that quirk.
    // Asserting the on: block is EXACTLY these two lines (not just "contains
    // workflow_dispatch") is what actually rules out a later push:/schedule:/
    // pull_request: trigger being added alongside it.
    const raw = readFileSync(new URL('../../.github/workflows/rollback-rehearsal.yml', import.meta.url), 'utf8');
    expect(raw).toMatch(/^on:\n {2}workflow_dispatch:\n\njobs:/m);
  });

  it('checks out with fetch-depth: 0 -- rollbackToLastGood needs full history + tags', () => {
    const workflow = loadWorkflow();
    const checkoutStep = getJob(workflow, 'rehearse').steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep!.with?.['fetch-depth']).toBe(0);
  });

  it('runs the rehearsal via the testable script, not inline bash', () => {
    const workflow = loadWorkflow();
    const step = getJob(workflow, 'rehearse').steps.find((s) => s.run?.includes('rollback-rehearsal.mjs'));
    expect(step).toBeDefined();
  });

  it('sources CapRover credentials via the same .env.caprover convention as the real rollback step', () => {
    const workflow = loadWorkflow();
    const step = getJob(workflow, 'rehearse').steps.find((s) => s.run?.includes('rollback-rehearsal.mjs'));
    expect(step!.run).toContain('op run --env-file=.env.caprover');
  });

  it('sets LAST_GOOD_TAG the same way deploy.yml does, before the rehearsal step', () => {
    const workflow = loadWorkflow();
    const steps = getJob(workflow, 'rehearse').steps;
    const vaultStepIndex = steps.findIndex((s) => s.run?.includes('LAST_GOOD_TAG'));
    const rehearsalStepIndex = steps.findIndex((s) => s.run?.includes('rollback-rehearsal.mjs'));
    expect(vaultStepIndex).toBeGreaterThan(-1);
    expect(rehearsalStepIndex).toBeGreaterThan(vaultStepIndex);
  });

  it('bounds the rehearsal step with an explicit timeout, independent of the job-level one', () => {
    const workflow = loadWorkflow();
    const step = getJob(workflow, 'rehearse').steps.find((s) => s.run?.includes('rollback-rehearsal.mjs'));
    expect(step!['timeout-minutes']).toBeGreaterThan(0);
  });

  it('declares a job-level timeout well below GitHub\'s 6h default', () => {
    const workflow = loadWorkflow();
    const timeout = getJob(workflow, 'rehearse')['timeout-minutes'];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(360);
  });

  it('never uploads deploy.tar.gz as a build artifact -- it contains a resolved .env with real secrets', () => {
    const workflow = loadWorkflow();
    const uploadSteps = getJob(workflow, 'rehearse').steps.filter((s) => s.uses?.startsWith('actions/upload-artifact'));
    for (const step of uploadSteps) {
      expect(JSON.stringify(step.with ?? {})).not.toContain('deploy.tar.gz');
    }
    // Belt-and-suspenders: no upload-artifact step should exist in this workflow at all
    // today -- the rehearsal has nothing worth keeping (the CapRover call is stubbed,
    // so there's no deploy log to preserve the way the real deploy step's is).
    expect(uploadSteps).toHaveLength(0);
  });
});
