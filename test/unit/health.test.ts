import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';

describe('GET /health (unit, via inject)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('returns 200 with {status:"ok"}', async () => {
    app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('includes a build identifier so a rolling-swap deploy can distinguish revisions', async () => {
    app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(typeof body.build).toBe('string');
    expect(body.build.length).toBeGreaterThan(0);
  });

  it('reports the BUILD_SHA env var when set, taking precedence over any on-disk file', async () => {
    const original = process.env.BUILD_SHA;
    process.env.BUILD_SHA = 'test-sha-override';
    try {
      app = buildApp();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().build).toBe('test-sha-override');
    } finally {
      if (original === undefined) delete process.env.BUILD_SHA;
      else process.env.BUILD_SHA = original;
    }
  });

  it('falls back to "dev" when no BUILD_SHA env var and no on-disk BUILD_SHA file exist', async () => {
    const original = process.env.BUILD_SHA;
    delete process.env.BUILD_SHA;
    try {
      app = buildApp();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().build).toBe('dev');
    } finally {
      if (original !== undefined) process.env.BUILD_SHA = original;
    }
  });

  it('reports database:"unreachable" (still HTTP 200) when DATABASE_URL is unset', async () => {
    // 86e2v0acm: DATABASE_URL was never wired into the running container, so
    // every data endpoint 500'd while /health stayed green -- it never touched
    // Postgres. This is the regression test proving /health now surfaces that.
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      app = buildApp();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok', database: 'unreachable' });
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});
