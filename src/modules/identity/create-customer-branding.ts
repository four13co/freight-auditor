import type pg from 'pg';
import { insertIdempotent } from '../../db/insert-idempotent.js';

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
 * `account_id` is UNIQUE (migration 0077): a second call for the same
 * tenant throws a unique-violation, surfaced by the route as 409, matching
 * this item's AC "409 if one already exists" -- update-customer-branding.ts
 * is the correct path once a row exists. `domain` is also UNIQUE, so a
 * domain-only collision (different account_id) still throws a real
 * unique-violation straight from the INSERT -- insertIdempotent's ON
 * CONFLICT target below only names `account_id`, matching this function's
 * own conflict of interest (86e39qa75's Solution named this file, not the
 * domain constraint). The account_id path is synthesized to the same
 * `{ code: '23505' }` shape (existing isUniqueViolation()-checked contract
 * at the tenant-admin-routes.ts call site, mirrored in that route's own
 * mocked unit-test error) so both conflict paths still land on the same
 * caller-side 409.
 */
export async function createCustomerBranding(
  client: pg.PoolClient,
  input: CreateCustomerBrandingInput,
): Promise<CreatedCustomerBranding> {
  const result = await insertIdempotent(client, {
    insertSql: `INSERT INTO customer_branding (account_id, domain, logo_url, primary_color, secondary_color)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_id) DO NOTHING`,
    insertParams: [input.clientId, input.domain, input.logoUrl, input.primaryColor, input.secondaryColor],
    fallbackSql: `SELECT id FROM customer_branding WHERE account_id = $6`,
    fallbackParams: [input.clientId],
  });

  if (!result || !result.created) {
    throw Object.assign(new Error('duplicate key value violates unique constraint "customer_branding_account_id_key"'), {
      code: '23505',
    });
  }

  return { logoUrl: input.logoUrl, primaryColor: input.primaryColor, secondaryColor: input.secondaryColor };
}
