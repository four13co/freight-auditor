import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkFileGating, checkAllRoutes } from '../../scripts/check-analyst-only-gating.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

/**
 * 86e36bf83: static check enforcing that a mutating route (POST/PUT/PATCH/
 * DELETE) in src/server/*-routes.ts is either nested inside a role-scoped
 * preHandler sub-scope or explicitly allow-listed as intentionally
 * portal-writable.
 */
describe('checkFileGating', () => {
  it('AC1: flags a new mutating route with no enclosing role-scoped preHandler and no allow-list entry', () => {
    const content = `
      export async function registerWidgetRoutes(routes: FastifyInstance): Promise<void> {
        await registerTenantAuthPreHandler(routes);
        routes.post('/api/widgets/:id/self-destruct', async (request, reply) => {
          return { ok: true };
        });
      }
    `;
    const violations = checkFileGating('widget-routes.ts', content);
    expect(violations).toEqual([
      { file: 'widget-routes.ts', method: 'POST', path: '/api/widgets/:id/self-destruct' },
    ]);
  });

  it('AC2: reports no false positive against the real, current dispute-review-routes.ts and findings-routes.ts', () => {
    for (const file of ['dispute-review-routes.ts', 'findings-routes.ts']) {
      const content = readFileSync(join(REPO_ROOT, 'src/server', file), 'utf8');
      expect(checkFileGating(file, content)).toEqual([]);
    }
  });

  it('AC3: a route explicitly present in the allow-list passes without requiring a role-scoped preHandler', () => {
    const content = `
      export async function registerDisputeReviewRoutes(routes: FastifyInstance): Promise<void> {
        await registerTenantAuthPreHandler(routes);
        routes.post('/api/disputes/:id/communications', async (request, reply) => {
          return { ok: true };
        });
      }
    `;
    expect(checkFileGating('dispute-review-routes.ts', content)).toEqual([]);
  });

  it('still flags a route matching an allow-listed path but the WRONG file (allow-list entries are file-scoped)', () => {
    const content = `
      export async function registerImposterRoutes(routes: FastifyInstance): Promise<void> {
        await registerTenantAuthPreHandler(routes);
        routes.post('/api/disputes/:id/communications', async (request, reply) => {
          return { ok: true };
        });
      }
    `;
    expect(checkFileGating('imposter-routes.ts', content)).toEqual([
      { file: 'imposter-routes.ts', method: 'POST', path: '/api/disputes/:id/communications' },
    ]);
  });

  it('does not flag a route nested inside a registerAnalystOnlyPreHandler sub-scope', () => {
    const content = `
      export async function registerWidgetRoutes(routes: FastifyInstance): Promise<void> {
        await registerTenantAuthPreHandler(routes);
        await routes.register(async (analystOnlyRoutes) => {
          await registerAnalystOnlyPreHandler(analystOnlyRoutes);
          analystOnlyRoutes.post('/api/widgets/:id/approve', async (request, reply) => {
            return { ok: true };
          });
        });
      }
    `;
    expect(checkFileGating('widget-routes.ts', content)).toEqual([]);
  });
});

describe('checkAllRoutes', () => {
  it('AC4: passes cleanly against the real src/server/*-routes.ts as of this task', () => {
    expect(checkAllRoutes()).toEqual([]);
  });
});
