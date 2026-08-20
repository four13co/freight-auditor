import Fastify, { type FastifyInstance } from 'fastify';
import { registerFindingsRoutes } from './findings-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerStaticRoutes } from './static-routes.js';

/**
 * Build the Fastify application instance.
 *
 * Kept separate from the server bootstrap (`index.ts`) so tests can build the
 * app and call `.inject()` without binding a TCP port.
 *
 * 86e2wb4zg: composes domain route modules rather than registering routes
 * inline -- app.ts previously carried every route plus their shared
 * imports/consts at its top level, which was the repo's one recurring
 * merge-collision point (86e2wwaeq's architecture review: PR #93 vs #91/#92,
 * PR #94 vs #91/#92, PR #103 vs #101/#102, all colliding on this same
 * top-of-file seam). Each domain module now owns its own imports/consts
 * alongside its routes; app.ts only imports and registers them.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // Static/health routes registered at top level -- must NOT be gated behind
  // findings-routes.ts's tenant-auth preHandler (see that module's header
  // comment for why).
  void app.register(registerStaticRoutes);

  // Auth routes registered at top level -- must be reachable with only a
  // session cookie (or no session at all), before any tenant scope exists
  // (see auth-routes.ts's header comment for why this can't be gated).
  void app.register(registerAuthRoutes);

  // Findings routes registered via their own encapsulation so the
  // tenant-auth preHandler binds ONLY to these routes (see
  // findings-routes.ts's header comment).
  void app.register(registerFindingsRoutes);

  return app;
}
