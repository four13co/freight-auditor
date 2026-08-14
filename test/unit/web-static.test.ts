import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Covers the branch where web/dist doesn't exist (e.g. before `npm run build`
 * has ever run in web/) — buildApp() must still serve /health and must not
 * register static-file handling that would 500 on a missing root (86e2u7j01).
 */
describe('buildApp() when web/dist is absent', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, existsSync: () => false };
    });
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.doUnmock('node:fs');
  });

  it('still serves /health', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('does not register static serving, so / 404s rather than erroring', async () => {
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
