import type pg from 'pg';

export interface UpdateCustomerBrandingInput {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string | null;
}

export interface UpdatedCustomerBranding {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string | null;
}

/**
 * 86e37r2t4: PATCH /api/internal/branding's backing write. Runs inside the
 * caller's withTenantTx -- RLS is FORCE-enabled on customer_branding
 * (migration 0077), so an UPDATE issued outside that transaction, or scoped
 * to a client_id the transaction doesn't carry, silently affects zero rows.
 * `clientId` is passed explicitly (not derived from RLS alone) only to
 * report a real 404 distinctly from "wrong tenant" -- the WHERE clause is the
 * actual security boundary, this is a targeting convenience.
 *
 * customer_branding.domain is NOT NULL UNIQUE (migration 0077) and is not
 * part of this item's form -- there is deliberately no INSERT path here.
 * `found: false` covers a tenant with no branding row yet (branding rows are
 * created by a separate, not-yet-built onboarding flow, per the migration's
 * own "reconfigure it, never remove it" comment) -- this endpoint only
 * reconfigures an existing row.
 */
export async function updateCustomerBranding(
  client: pg.PoolClient,
  clientId: string,
  input: UpdateCustomerBrandingInput,
): Promise<{ found: true; branding: UpdatedCustomerBranding } | { found: false }> {
  const result = await client.query<{
    logo_url: string;
    primary_color: string;
    secondary_color: string | null;
  }>(
    `UPDATE customer_branding
        SET logo_url = $2, primary_color = $3, secondary_color = $4, updated_at = now()
      WHERE client_id = $1
      RETURNING logo_url, primary_color, secondary_color`,
    [clientId, input.logoUrl, input.primaryColor, input.secondaryColor],
  );
  const row = result.rows[0];
  if (!row) return { found: false };
  return {
    found: true,
    branding: { logoUrl: row.logo_url, primaryColor: row.primary_color, secondaryColor: row.secondary_color },
  };
}
