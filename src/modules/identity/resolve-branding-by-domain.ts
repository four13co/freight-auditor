import type pg from 'pg';

export interface CustomerBranding {
  clientId: string;
  domain: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string | null;
}

/**
 * Strips a port suffix (`bank.example.com:4180`, as a request's Host header
 * carries in dev/CI) and lowercases -- domain is stored lowercase (whatever
 * case the Customer registered it in), and a request's Host header casing
 * is not something a visitor's browser can be relied on to normalize.
 */
export function normalizeDomain(host: string): string {
  return host.split(':')[0]!.toLowerCase();
}

/**
 * 86e320pkc AC3 (unit half): the domain -> Customer id lookup itself,
 * "strictly by request domain" -- an exact match against customer_branding's
 * UNIQUE domain column, never a prefix/suffix/subdomain match, so two
 * Customers each on their own domain can never bleed into one another (no
 * amount of shared platform infrastructure changes which row this returns).
 *
 * Takes a bare pg.PoolClient rather than opening its own transaction --
 * same shape as list-claim-aging-queues.ts's list functions -- because this
 * runs BEFORE any tenant scope is known for the request (the domain IS how
 * the caller finds out which Customer this is), so the caller (branding-
 * routes.ts) is responsible for wrapping this in an internal-scoped
 * transaction (withTenantReadTx, internal scope), mirroring tenant-auth.ts's
 * lookupMembership.
 */
export async function resolveBrandingByDomain(
  client: pg.PoolClient,
  host: string,
): Promise<CustomerBranding | null> {
  const domain = normalizeDomain(host);
  const result = await client.query<{
    client_id: string;
    domain: string;
    logo_url: string;
    primary_color: string;
    secondary_color: string | null;
  }>(
    `SELECT client_id, domain, logo_url, primary_color, secondary_color
       FROM customer_branding
      WHERE domain = $1`,
    [domain],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    domain: row.domain,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
  };
}
