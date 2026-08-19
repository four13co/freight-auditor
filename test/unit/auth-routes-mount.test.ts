import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Request-level unit coverage of the /api/auth/* mount's Fastify<->Fetch
 * adaptation (86e2v1bdj), with getAuth() mocked so this runs with no live
 * Postgres/better-auth instance. Complements test/db/auth-routes.db.test.ts,
 * which covers the real better-auth round-trip (sign-up/sign-in/session)
 * against a real DB and stays the source of truth there -- this file only
 * exercises app.ts's own req/res adaptation logic (method, headers, body,
 * multi-value set-cookie, empty body).
 */
describe('/api/auth/* mount (unit, mocked getAuth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
  });

  it('adapts a GET request (no body) into a Fetch Request and returns the handler response', async () => {
    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ handler }) }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const forwardedRequest = handler.mock.calls[0]?.[0] as Request;
    expect(forwardedRequest.method).toBe('GET');
    expect(forwardedRequest.url).toContain('/api/auth/get-session');
  });

  it('adapts a POST request body into the forwarded Fetch Request', async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ handler }) }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@example.com', password: 'hunter2' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const forwardedRequest = handler.mock.calls[0]?.[0] as Request;
    expect(forwardedRequest.method).toBe('POST');
    await expect(forwardedRequest.json()).resolves.toEqual({ email: 'a@example.com', password: 'hunter2' });
  });

  it('forwards multiple set-cookie header values from the handler response', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200, headers }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ handler }) }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });

    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('is not gated behind tenant-auth (reachable with no x-client-id/x-user-id headers)', async () => {
    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ handler }) }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });

    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * 86e2wb92b: unit coverage of GET /api/auth/memberships, with getAuth() and
 * listMembershipClientIds mocked so this runs with no live Postgres.
 * Complements test/db/auth-memberships.db.test.ts, which covers the real
 * membership-lookup query against real Postgres and stays the source of
 * truth there -- this file only exercises the route's own session-check +
 * response-shape logic.
 */
describe('GET /api/auth/memberships (unit, mocked getAuth + listMembershipClientIds)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
  });

  it('AC1: returns { clientIds } for a valid session', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'user-1' } });
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    const listMembershipClientIds = vi.fn().mockResolvedValue(['client-1']);
    vi.doMock('../../src/modules/findings/tenant-auth.js', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      listMembershipClientIds,
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships', headers: { cookie: 'session=x' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientIds: ['client-1'] });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(listMembershipClientIds).toHaveBeenCalledWith('user-1');
  });

  it('AC3: returns 401 without calling listMembershipClientIds when there is no valid session', async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    const listMembershipClientIds = vi.fn();
    vi.doMock('../../src/modules/findings/tenant-auth.js', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      listMembershipClientIds,
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships' });

    expect(res.statusCode).toBe(401);
    expect(listMembershipClientIds).not.toHaveBeenCalled();
  });
});
