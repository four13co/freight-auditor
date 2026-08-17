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
    env?: Record<string, unknown>;
    'timeout-minutes'?: number;
  }>;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
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

  it('allows the guard to pass on Development (dedicated dev DB) but not on other branches (86e25uqxa)', () => {
    // freight-auditor-dev's DATABASE_URL is a dedicated dev Neon instance, not shared/
    // production, so CI is allowed to auto-migrate it. Production has no DATABASE_URL
    // secret yet and gets no override — the guard stays live there.
    const workflow = loadDeployWorkflow();
    const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
      step.run?.includes('npm run migrate'),
    );
    expect(migrateStep!.env?.ALLOW_PROTECTED_DB_HOST).toBe(
      "${{ github.ref_name == 'Development' && '1' || '' }}",
    );
  });

  it('deploys via the caprover CLI, not the raw webhook curl (86e25uqxa)', () => {
    // The webhook curl this test used to check for (`"$status" != "100"`) was replaced in
    // PR #27: it authenticated with the app token as a header, but that endpoint expects it
    // as a query param, so every deploy failed with status:1106 regardless of token validity.
    // The caprover CLI sends auth the way the API actually expects.
    const workflow = loadDeployWorkflow();
    const deployStep = getJob(workflow, 'deploy').steps.find((step) => step.name === 'Deploy to CapRover');
    expect(deployStep).toBeDefined();
    expect(deployStep!.run).toContain('caprover deploy');
    expect(deployStep!.run).toContain('--caproverUrl');
    expect(deployStep!.run).toContain('--appToken');
  });

  describe('deployment tarball contents (86e25uqxa)', () => {
    // CapRover untars the uploaded tarball and uses it as the ENTIRE Docker build
    // context — nothing else from the repo is present. So every path the build
    // touches has to be inside the tar, or the server-side build fails while the
    // `caprover deploy` CLI still exits 0 (it confirms the upload, not the build).
    // That combination is what made CI green while the app never actually ran:
    // captain-definition pointed at ./Dockerfile, which was never shipped.
    function getTarballCommand(): string {
      const workflow = loadDeployWorkflow();
      const step = getJob(workflow, 'deploy').steps.find((s) => s.run?.includes('tar -czf'));
      if (!step) throw new Error('expected a step that creates the deployment tarball');
      return step.run!;
    }

    it('ships the Dockerfile that captain-definition points at', () => {
      const dockerfilePath = (
        JSON.parse(
          readFileSync(new URL('../../captain-definition', import.meta.url), 'utf8'),
        ) as { dockerfilePath: string }
      ).dockerfilePath;
      // './Dockerfile' -> 'Dockerfile'
      const relativePath = dockerfilePath.replace(/^\.\//, '');
      expect(getTarballCommand()).toContain(relativePath);
    });

    it('ships captain-definition, the manifest CapRover reads first', () => {
      expect(getTarballCommand()).toContain('captain-definition');
    });

    it('ships the build output and the manifests npm ci needs', () => {
      const tarCommand = getTarballCommand();
      for (const required of ['dist/', 'package.json', 'package-lock.json']) {
        expect(tarCommand).toContain(required);
      }
    });

    it('ships web/dist/ -- the dashboard has never been deployed without this (86e2v07n3)', () => {
      // Same failure class as 86e2tn08g/PR #40 (rollback tarball omitted the
      // Dockerfile): the tarball is the ENTIRE Docker build context, so
      // web/dist/ absent here means the frontend never reaches the image
      // regardless of what the Dockerfile does with it.
      expect(getTarballCommand()).toContain('web/dist/');
    });

    it('ships the resolved .env -- without it the container has no runtime config at all (86e2v0acm)', () => {
      expect(getTarballCommand()).toContain('.env');
    });

    it('does NOT ship .dockerignore -- it is not consulted for a CapRover build, so it must never be relied on as a filter', () => {
      expect(getTarballCommand()).not.toContain('.dockerignore');
    });
  });

  describe('runtime env resolution (86e2v0acm)', () => {
    function getEnvResolveStep() {
      const workflow = loadDeployWorkflow();
      const step = getJob(workflow, 'deploy').steps.find((s) => s.run?.includes('op inject'));
      if (!step) throw new Error('expected a step that resolves .env via op inject');
      return step;
    }

    it('resolves the runtime env file before the tarball is created', () => {
      const workflow = loadDeployWorkflow();
      const steps = getJob(workflow, 'deploy').steps;
      const injectIndex = steps.findIndex((s) => s.run?.includes('op inject'));
      const tarIndex = steps.findIndex((s) => s.run?.includes('tar -czf'));
      expect(injectIndex).toBeGreaterThan(-1);
      expect(tarIndex).toBeGreaterThan(injectIndex);
    });

    it('substitutes the vault placeholder before injection runs', () => {
      const step = getEnvResolveStep();
      const sedIndex = step.run!.indexOf('sed');
      const injectIndex = step.run!.indexOf('op inject');
      expect(sedIndex).toBeGreaterThan(-1);
      expect(sedIndex).toBeLessThan(injectIndex);
      expect(step.run).toContain('OP_VAULT');
    });

    it('deletes the resolved file from the runner after packaging -- it must not outlive this one job', () => {
      // The delete happens in the SAME step's multi-line run block as the tar
      // command (see the "Create deployment tarball" step) -- ordering is
      // checked within that one string, not across separate steps.
      const workflow = loadDeployWorkflow();
      const tarStep = getJob(workflow, 'deploy').steps.find((s) => s.run?.includes('tar -czf'));
      expect(tarStep).toBeDefined();
      const tarIndex = tarStep!.run!.indexOf('tar -czf');
      const cleanupIndex = tarStep!.run!.indexOf('rm .env');
      expect(cleanupIndex).toBeGreaterThan(tarIndex);
    });

    it('fails the job when a reference is left unresolved after injection', () => {
      const step = getEnvResolveStep();
      expect(step.run).toContain('exit 1');
    });
  });

  describe('Dockerfile loads the baked-in env file at boot (86e2v0acm)', () => {
    it('copies the env file into the image, after the dependency install so it does not bust that layer', () => {
      const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
      const npmCiIndex = dockerfile.indexOf('RUN npm ci');
      const copyEnvIndex = dockerfile.indexOf('COPY .env');
      expect(copyEnvIndex).toBeGreaterThan(-1);
      expect(copyEnvIndex).toBeGreaterThan(npmCiIndex);
    });

    it('boots tolerating a missing env file -- an image built without one must still start', () => {
      const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
      expect(dockerfile).toContain('--env-file-if-exists=.env');
    });

    it('does not depend on a dotenv package -- Node loads the file natively', () => {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.dotenv).toBeUndefined();
      expect(pkg.devDependencies?.dotenv).toBeUndefined();
    });
  });

  describe('frontend build (86e2v07n3 -- the dashboard has never been deployed)', () => {
    it('builds the frontend before packaging: npm ci --prefix web then npm --prefix web run build', () => {
      const workflow = loadDeployWorkflow();
      const steps = getJob(workflow, 'deploy').steps;
      const webInstallStep = steps.find((s) => s.run?.includes('npm ci --prefix web'));
      const webBuildStep = steps.find((s) => s.run?.includes('npm --prefix web run build'));
      expect(webInstallStep).toBeDefined();
      expect(webBuildStep).toBeDefined();
    });

    it('builds the frontend before creating the tarball, not after', () => {
      const workflow = loadDeployWorkflow();
      const steps = getJob(workflow, 'deploy').steps;
      const webBuildIndex = steps.findIndex((s) => s.run?.includes('npm --prefix web run build'));
      const tarIndex = steps.findIndex((s) => s.run?.includes('tar -czf'));
      expect(webBuildIndex).toBeGreaterThan(-1);
      expect(tarIndex).toBeGreaterThan(webBuildIndex);
    });

    it('does not build the frontend inside the Docker image -- it must arrive pre-built', () => {
      const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
      expect(dockerfile).not.toContain('npm --prefix web run build');
      expect(dockerfile).not.toContain('vite build');
    });

    it('copies web/dist to the exact path resolveWebDist() resolves to inside the image (/app/web/dist)', () => {
      // src/server/app.ts's resolveWebDist() is import.meta.url-relative to the
      // RUNNING compiled file. The Dockerfile's CMD runs dist/server/index.js,
      // so app.js lives at /app/dist/server/app.js in this image (WORKDIR /app,
      // COPY dist ./dist) -- ../../web/dist from there resolves to /app/web/dist,
      // not /app/dist/web. Getting this wrong fails silently (the server
      // tolerates a missing directory by design) -- verified empirically by
      // running the compiled server against this exact directory layout.
      const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
      expect(dockerfile).toContain('COPY web/dist ./web/dist');
    });
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

    it('installs the CapRover CLI before the rollback step (86e2v0ked -- each job is a fresh runner; the deploy job\'s own install does not carry over)', () => {
      const workflow = loadDeployWorkflow();
      const steps = getJob(workflow, 'post-deployment').steps;
      const installIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('install caprover cli'));
      const rollbackIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('roll back'));
      expect(installIdx).toBeGreaterThanOrEqual(0);
      expect(rollbackIdx).toBeGreaterThanOrEqual(0);
      expect(installIdx).toBeLessThan(rollbackIdx);
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

    it('advances the last-good tag via the testable script, not inline bash (86e2urk0k)', () => {
      const workflow = loadDeployWorkflow();
      const tagStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.name?.toLowerCase().includes('advance last-good tag'),
      );
      expect(tagStep!.run).toContain('advance-last-good-tag.mjs');
      expect(tagStep!.env?.GITHUB_SHA).toBe('${{ github.sha }}');
    });
  });

  describe('auto-seed dev tenant after migrations (86e2uut65)', () => {
    it('runs npm run seed:dev in the SAME op run block as the migration, not a separate step', () => {
      const workflow = loadDeployWorkflow();
      const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
        step.run?.includes('npm run migrate'),
      );
      expect(migrateStep!.run).toContain('npm run seed:dev');
      expect(migrateStep!.run).toContain('op run --env-file=.env.migrate');
    });

    it('runs the migration before the seed step, not the other way around', () => {
      const workflow = loadDeployWorkflow();
      const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
        step.run?.includes('npm run migrate'),
      );
      const migrateIndex = migrateStep!.run!.indexOf('npm run migrate');
      const seedIndex = migrateStep!.run!.indexOf('npm run seed:dev');
      expect(migrateIndex).toBeGreaterThan(-1);
      expect(seedIndex).toBeGreaterThan(migrateIndex);
    });

    it('still runs the protected-host guard before the migration (86e2uut65 must not reorder around it)', () => {
      const workflow = loadDeployWorkflow();
      const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
        step.run?.includes('npm run migrate'),
      );
      const guardIndex = migrateStep!.run!.indexOf('guard-protected-db.mjs');
      const migrateIndex = migrateStep!.run!.indexOf('npm run migrate');
      expect(guardIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(migrateIndex);
    });

    it('gates the seed step on Development exactly like ALLOW_PROTECTED_DB_HOST (no seeding on Production)', () => {
      const workflow = loadDeployWorkflow();
      const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
        step.run?.includes('npm run migrate'),
      );
      expect(migrateStep!.env?.SEED_DEV_ON_DEPLOY).toBe("${{ github.ref_name == 'Development' && '1' || '' }}");
    });

    it('does not add a DATABASE_URL secret or otherwise change how DATABASE_URL is sourced', () => {
      const workflow = loadDeployWorkflow();
      const migrateStep = getJob(workflow, 'migrate-database').steps.find((step) =>
        step.run?.includes('npm run migrate'),
      );
      expect(migrateStep!.run).toContain('op run --env-file=.env.migrate');
      expect(Object.keys(migrateStep!.env ?? {})).not.toContain('DATABASE_URL');
    });
  });

  describe('concurrency control (86e2urk0k)', () => {
    it('serializes runs on the same branch so overlapping deploys queue rather than race', () => {
      const workflow = loadDeployWorkflow();
      expect(workflow.concurrency?.group).toBe('deploy-${{ github.ref }}');
    });

    it('does NOT cancel an in-progress run -- a deploy that already migrated/deployed must finish, not be killed mid-way', () => {
      const workflow = loadDeployWorkflow();
      expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
    });
  });

  describe('job timeouts (86e2v1qrn -- an unbounded hang blocks every subsequent deploy)', () => {
    // cancel-in-progress: false (86e2urk0k) means a hung step holds the
    // concurrency group indefinitely with no automatic recovery -- observed
    // live: the rollback step ran 2h12m (run 31973373618) before a human
    // cancelled it, extending the 86e2v0acm outage by over two hours.
    it.each(['migrate-database', 'deploy', 'post-deployment'])(
      'job "%s" declares an explicit timeout-minutes well below GitHub\'s 6h default',
      (jobName) => {
        const workflow = loadDeployWorkflow();
        const timeout = getJob(workflow, jobName)['timeout-minutes'];
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThan(360);
      },
    );

    it('bounds the rollback step specifically, not just the job as a whole', () => {
      const workflow = loadDeployWorkflow();
      const rollbackStep = getJob(workflow, 'post-deployment').steps.find((s) =>
        s.name?.toLowerCase().includes('roll back'),
      );
      expect(rollbackStep!['timeout-minutes']).toBeGreaterThan(0);
    });
  });
});
