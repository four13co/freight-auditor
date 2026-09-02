import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { normalizeDomain, resolveBrandingByDomain } from '../../src/modules/identity/resolve-branding-by-domain.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000002';

function mockClient(resolved: unknown) {
  const query = vi.fn().mockResolvedValue(resolved);
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('normalizeDomain', () => {
  it('lowercases and strips a port suffix', () => {
    expect(normalizeDomain('Bank-A.Example.com:4180')).toBe('bank-a.example.com');
  });

  it('leaves a bare hostname (no port) unchanged aside from lowercasing', () => {
    expect(normalizeDomain('BANK-A.EXAMPLE.COM')).toBe('bank-a.example.com');
  });
});

describe('resolveBrandingByDomain', () => {
  it('AC3 (unit): resolves strictly by request domain -> Customer id, mapping the row to camelCase', async () => {
    const { client, query } = mockClient({
      rows: [
        {
          client_id: CLIENT_ID,
          domain: 'bank-a.example.com',
          logo_url: 'https://cdn.example.com/bank-a/logo.png',
          primary_color: '#123456',
          secondary_color: '#abcdef',
        },
      ],
    });

    const result = await resolveBrandingByDomain(client, 'bank-a.example.com:4180');

    expect(result).toEqual({
      clientId: CLIENT_ID,
      domain: 'bank-a.example.com',
      logoUrl: 'https://cdn.example.com/bank-a/logo.png',
      primaryColor: '#123456',
      secondaryColor: '#abcdef',
    });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM customer_branding');
    expect(sql).toContain('WHERE domain = $1');
    // The port was stripped before hitting the query -- a request's Host
    // header carrying a port must never fail to match a stored bare domain.
    expect(values).toEqual(['bank-a.example.com']);
  });

  it('returns null when no Customer has configured this domain (AC2: default-domain fallback)', async () => {
    const { client } = mockClient({ rows: [] });
    const result = await resolveBrandingByDomain(client, 'app.default-platform.com');
    expect(result).toBeNull();
  });

  it('AC3: a null secondary_color maps to null, not undefined or the string "null"', async () => {
    const { client } = mockClient({
      rows: [
        {
          client_id: CLIENT_ID,
          domain: 'bank-b.example.com',
          logo_url: 'https://cdn.example.com/bank-b/logo.png',
          primary_color: '#000000',
          secondary_color: null,
        },
      ],
    });
    const result = await resolveBrandingByDomain(client, 'bank-b.example.com');
    expect(result?.secondaryColor).toBeNull();
  });
});
