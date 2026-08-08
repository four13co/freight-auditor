import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Array<{ id?: string; name?: string; run?: string; uses?: string; if?: string }>;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

function loadDeployWorkflow(): Workflow {
  const raw = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  return load(raw) as Workflow;
}

function getJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  if (!job) throw new Error(`expected job "${name}" to exist in deploy.yml`);
  return job;
}

describe('deploy.yml (unit, job-dependency + guard wiring)', () => {
  it('gates the deploy job on migrate-database via `needs`', () => {
    const workflow = loadDeployWorkflow();
    expect(workflow.jobs['migrate-database']).toBeDefined();
    expect(getJob(workflow, 'deploy').needs).toBe('migrate-database');
  });

  it('runs the protected-host guard before the migration command', () => {
    const workflow = loadDeployWorkflow();
    const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
      step.run?.includes('npm run migrate'),
    );
    expect(migrateStep).toBeDefined();
    const guardIndex = migrateStep!.run!.indexOf('guard-protected-db.mjs');
    const migrateIndex = migrateStep!.run!.indexOf('npm run migrate');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(migrateIndex);
  });

  it('sources DATABASE_URL for the migration step via op run against .env.migrate', () => {
    const workflow = loadDeployWorkflow();
    const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
      step.run?.includes('npm run migrate'),
    );
    expect(migrateStep!.run).toContain('op run --env-file=.env.migrate');
  });

  it('leaves the existing deploy job status-check step unchanged', () => {
    const workflow = loadDeployWorkflow();
    const deployStep = getJob(workflow, 'deploy').steps.find((step) => step.name === 'Deploy to CapRover');
    expect(deployStep).toBeDefined();
    expect(deployStep!.run).toContain('"$status" != "100"');
  });

  describe('post-deployment health-check + rollback (86e27d4rh)', () => {
    it('gates on the deploy job via `needs`', () => {
      const workflow = loadDeployWorkflow();
      expect(getJob(workflow, 'post-deployment').needs).toBe('deploy');
    });

    it('grants contents:write so the last-good tag can be pushed', () => {
      const workflow = loadDeployWorkflow();
      expect(getJob(workflow, 'post-deployment').permissions?.contents).toBe('write');
    });

    it('runs the health-check poll via the testable script, not inline bash', () => {
      const workflow = loadDeployWorkflow();
      const healthcheckStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.run?.includes('post-deploy-healthcheck.mjs'),
      );
      expect(healthcheckStep).toBeDefined();
    });

    it('gates the rollback step on the health-check step having failed', () => {
      const workflow = loadDeployWorkflow();
      const rollbackStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.name?.toLowerCase().includes('roll back'),
      );
      expect(rollbackStep).toBeDefined();
      expect(rollbackStep!.if).toContain('failure()');
      expect(rollbackStep!.if).toContain("steps.healthcheck.outcome == 'failure'");
    });

    it('runs the rollback via the testable script, not inline bash (AC2 wiring)', () => {
      const workflow = loadDeployWorkflow();
      const rollbackStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.name?.toLowerCase().includes('roll back'),
      );
      expect(rollbackStep!.run).toContain('rollback-deploy.mjs');
      // the same env-file convention as the primary "Deploy to CapRover" step —
      // rollback needs CAPROVER_URL/CAPROVER_APP_TOKEN, not a bespoke source
      expect(rollbackStep!.run).toContain('op run --env-file=.env.caprover');
    });

    it('gates advancing the last-good tag on overall job success — so a failed health-check (even after a successful rollback) still leaves the job failed', () => {
      const workflow = loadDeployWorkflow();
      const tagStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.name?.toLowerCase().includes('advance last-good tag'),
      );
      expect(tagStep).toBeDefined();
      expect(tagStep!.if).toBe('success()');
    });
  });
});
