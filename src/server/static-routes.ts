import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { getPool } from '../db/pool.js';

/**
 * The running revision's build SHA, for a rolling-deploy health check to tell
 * revisions apart. `BUILD_SHA` wins for tests/local dev; otherwise read the
 * file the CI build step writes into the image (see .github/workflows/deploy.yml).
 *
 * This function (and resolveWebDist below) depend on this file living
 * directly in src/server/ -- both resolve paths relative to import.meta.url
 * (BUILD_SHA next to the compiled module; web/dist two levels up). Moving
 * this file into a subdirectory (e.g. src/server/routes/) would silently
 * break both without any test failing -- there is no test coverage of the
 * production deploy layout these paths assume.
 */
function resolveBuildSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, 'BUILD_SHA'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

/**
 * Locate the built frontend (web/dist) relative to the repo root. Not present
 * in the production image yet (Dockerfile/deploy tarball only ship the
 * backend's dist/ — see 86e2u7j01's PR for the follow-up); this resolves for
 * local dev (tsx, repo root two levels up from src/server) and for tests run
 * from the repo root.
 */
function resolveWebDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', '..', 'web', 'dist');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * 86e2wb4zg: /health + static file serving, split out of app.ts's shared
 * import/const seam into its own domain module (86e2wwaeq's architecture
 * review). Mechanical move -- no behavior change; registered by app.ts as
 * `app.register(registerStaticRoutes)`.
 *
 * Registered at TOP LEVEL by the caller, outside findings-routes.ts's
 * tenant-auth preHandler scope -- that encapsulation exists specifically so
 * the preHandler binds only to findings routes; registering these routes
 * inside it would 401 /health and break the rolling-deploy health check.
 */
export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  const buildSha = resolveBuildSha();

  // Deliberately never throws and never changes the response status: /health also
  // functions as CapRover's container-liveness probe, and a 5xx or hang here would
  // trigger restart-loop behavior unrelated to the actual DB outage. The `database`
  // field is the signal for callers (post-deploy-healthcheck.mjs) who care about
  // more than "the process is up" -- see 86e2v0acm, where DATABASE_URL was never
  // wired into the running container and every data endpoint 500'd while /health
  // stayed green because it never touched Postgres.
  app.get('/health', async () => {
    let database: 'ok' | 'unreachable';
    try {
      await getPool().query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'unreachable';
    }
    return { status: 'ok', build: buildSha, database };
  });

  const webDist = resolveWebDist();
  if (webDist) {
    void app.register(fastifyStatic, {
      root: webDist,
      index: 'index.html',
    });
  }
}
