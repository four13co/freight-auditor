import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFindings, fetchFindingsSummary, fetchAndStoreClientId } from '../src/lib/api.js';

/**
 * 86e2urebj: the dashboard broke on Development because fetchFindings/
 * fetchFindingsSummary sent bare fetch() calls with no headers, and neither
 * PR's test suite caught it -- Dashboard.test.tsx's mockFetch never
 * inspected the request init, and the backend's own tests inject headers
 * explicitly. This file asserts the actual headers sent, which is exactly
 * the coverage gap that let the regression through (this item's AC3).
 */
function headersFromInit(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

describe('api.ts auth headers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC1: fetchFindings sends both x-client-id and x-user-id headers', async () => {
    await fetchFindings();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersFromInit(init);
    expect(headers['x-client-id']).toBeTruthy();
    expect(headers['x-user-id']).toBeTruthy();
  });

  it('AC2: fetchFindingsSummary sends both x-client-id and x-user-id headers', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ recoverableOpen: '0', flaggedToday: 0, withCarriers: 0, recoveredLast30Days: '0' }),
        { status: 200 },
      ),
    );
    await fetchFindingsSummary();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersFromInit(init);
    expect(headers['x-client-id']).toBeTruthy();
    expect(headers['x-user-id']).toBeTruthy();
  });

  it('AC3: both calls send the SAME header values (single source, not divergent literals)', async () => {
    await fetchFindings();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ recoverableOpen: '0', flaggedToday: 0, withCarriers: 0, recoveredLast30Days: '0' }),
        { status: 200 },
      ),
    );
    await fetchFindingsSummary();

    const findingsHeaders = headersFromInit(fetchMock.mock.calls[0]?.[1] as RequestInit);
    const summaryHeaders = headersFromInit(fetchMock.mock.calls[1]?.[1] as RequestInit);
    expect(findingsHeaders['x-client-id']).toBe(summaryHeaders['x-client-id']);
    expect(findingsHeaders['x-user-id']).toBe(summaryHeaders['x-user-id']);
  });
});

/**
 * 86e2v24uf: authHeaders() shipped the hardcoded dev UUID pair into the
 * production bundle unconditionally -- anyone reading the public JS got a
 * live credential pair against the deployed dev environment. Gated behind
 * import.meta.env.DEV so a production build never sends it. The suite above
 * proves the dev-mode behavior is unchanged (vitest's import.meta.env.DEV is
 * true by default); this suite proves the prod-mode gate actually closes.
 */
describe('api.ts auth headers (production build)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('does not send x-client-id or x-user-id when import.meta.env.DEV is false and no client_id is stored', async () => {
    await fetchFindings();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersFromInit(init);
    expect(headers['x-client-id']).toBeUndefined();
    expect(headers['x-user-id']).toBeUndefined();
  });
});

/**
 * 86e2wb92b: the real-session path -- a production build with a client_id
 * already stored (by App.tsx, after a successful /api/auth/memberships
 * lookup) sends it as x-client-id. Never x-user-id: resolveViaSession
 * (tenant-auth.ts) derives the user from the session cookie itself, not a
 * header, so sending one here would be a client-controlled value the
 * backend never reads -- easily mistaken for an identity-spoofing vector.
 */
describe('api.ts auth headers (real session, stored client_id)', () => {
  const STORAGE_KEY = 'freight-auditor:client-id';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem(STORAGE_KEY, 'stored-client-id');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('sends the stored client_id as x-client-id, and never sends x-user-id', async () => {
    await fetchFindings();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersFromInit(init);
    expect(headers['x-client-id']).toBe('stored-client-id');
    expect(headers['x-user-id']).toBeUndefined();
  });
});

/**
 * 86e2v1bdj: `vite build` bakes import.meta.env.DEV to false, so CI's
 * web-fullstack job (which builds a real production bundle via `npm --prefix
 * web run build` and serves it with the real server, DEV_AUTH_HEADERS=1
 * server-side) got a bundle that sent no auth headers at all once
 * import.meta.env.DEV became the only gate -- breaking that suite (it is not
 * the deployed-environment question 86e2v24uf's PR discussion focused on).
 * VITE_DEV_AUTH_HEADERS is a SEPARATE, explicit build-time opt-in (Vite only
 * exposes VITE_-prefixed vars to client code) set ONLY in the CI build step
 * for that suite -- authHeaders() must send the dev pair when this is set,
 * even in an otherwise-production (DEV=false) build, so the e2e suite keeps
 * proving the dev-header path per its own AC5 without reopening 86e2v24uf's
 * exposure for a real deploy (which never sets this var).
 */
describe('api.ts auth headers (VITE_DEV_AUTH_HEADERS opt-in for a non-dev build)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_AUTH_HEADERS', '1');
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('still sends x-client-id/x-user-id in a non-dev build when VITE_DEV_AUTH_HEADERS=1', async () => {
    await fetchFindings();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersFromInit(init);
    expect(headers['x-client-id']).toBeTruthy();
    expect(headers['x-user-id']).toBeTruthy();
  });
});

/**
 * 86e2wb92b: fetchAndStoreClientId() is App.tsx's post-login lookup --
 * called once a real session exists, before authHeaders() has anything to
 * send on the real-session path.
 */
describe('fetchAndStoreClientId', () => {
  const STORAGE_KEY = 'freight-auditor:client-id';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('AC1: stores the first client_id returned by GET /api/auth/memberships', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientIds: ['c1', 'c2'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndStoreClientId();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/memberships');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('c1');
  });

  it('AC3: stores nothing when the user has zero memberships (empty clientIds)', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientIds: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndStoreClientId();

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('AC3: stores nothing and does not throw when the lookup itself fails (e.g. 401, no session)', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAndStoreClientId()).resolves.toBeUndefined();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
