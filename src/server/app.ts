import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * The running revision's build SHA, for a rolling-deploy health check to tell
 * revisions apart. `BUILD_SHA` wins for tests/local dev; otherwise read the
 * file the CI build step writes into the image (see .github/workflows/deploy.yml).
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
 * Build the Fastify application instance.
 *
 * Kept separate from the server bootstrap (`index.ts`) so tests can build the
 * app and call `.inject()` without binding a TCP port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  const buildSha = resolveBuildSha();

  app.get('/health', async () => {
    return { status: 'ok', build: buildSha };
  });

  const webDist = resolveWebDist();
  if (webDist) {
    void app.register(fastifyStatic, {
      root: webDist,
      index: 'index.html',
    });
  }

  return app;
}
