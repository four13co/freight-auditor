import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFindings, fetchFindingsSummary } from '../src/lib/api.js';

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
