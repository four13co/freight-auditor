import type pg from 'pg';

export interface CreateCustomerBrandingInput {
  clientId: string;
  domain: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string | null;
}

export interface CreatedCustomerBranding {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string | null;
}

/**
 * 86e38rdnm: the INSERT half of customer_branding, companion to
 * update-customer-branding.ts's UPDATE-only path. Runs inside the caller's
 * withTenantTx ({ internal: true } for the tenant-admin flow -- the caller
 * has no membership in the tenant it's provisioning branding for) --
 * FORCE RLS's WITH CHECK clause (migration 0009) admits the insert via
 * app_is_internal(), independent of clientId.
 *
 * `client_id` is UNIQUE (migration 0077): a second call for the same
 * tenant throws a unique-violation, surfaced by the route as 409, matching
 * this item's AC "409 if one already exists" -- update-customer-branding.ts
 * is the correct path once a row exists.
 */
export async function createCustomerBranding(
  client: pg.PoolClient,
  input: CreateCustomerBrandingInput,
): Promise<CreatedCustomerBranding> {
  const { rows } = await client.query<{
    logo_url: string;
    primary_color: string;
    secondary_color: string | null;
  }>(
    `INSERT INTO customer_branding (client_id, domain, logo_url, primary_color, secondary_color)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING logo_url, primary_color, secondary_color`,
    [input.clientId, input.domain, input.logoUrl, input.primaryColor, input.secondaryColor],
  );
  const row = rows[0]!;
  return { logoUrl: row.logo_url, primaryColor: row.primary_color, secondaryColor: row.secondary_color };
}
