import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

interface WorkflowJob {
  needs?: string | string[];
  steps: Array<{ name?: string; run?: string; uses?: string }>;
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
});
