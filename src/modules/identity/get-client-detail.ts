import type pg from 'pg';

export interface ClientDetail {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  branding: {
    domain: string;
    logoUrl: string;
    primaryColor: string;
    secondaryColor: string | null;
  } | null;
  memberCount: number;
}

/**
 * 86e38rdnm: tenant detail -- the client row plus its (possibly absent)
 * branding config and a member count, one round trip. `branding: null`
 * is the fresh-tenant case the Branding tab's CREATE-vs-UPDATE toggle keys
 * off of.
 */
export async function getClientDetail(client: pg.PoolClient, clientId: string): Promise<ClientDetail | null> {
  const { rows } = await client.query<{
    id: string; name: string; slug: string; is_active: boolean; created_at: Date;
    domain: string | null; logo_url: string | null; primary_color: string | null; secondary_color: string | null;
    member_count: string;
  }>(
    `SELECT
       client.id, client.name, client.slug, client.is_active, client.created_at,
       customer_branding.domain, customer_branding.logo_url, customer_branding.primary_color, customer_branding.secondary_color,
       (SELECT count(*) FROM membership WHERE membership.client_id = client.id) AS member_count
     FROM client
     LEFT JOIN customer_branding ON customer_branding.client_id = client.id
     WHERE client.id = $1`,
    [clientId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.is_active,
    createdAt: row.created_at,
    branding: row.domain
      ? { domain: row.domain, logoUrl: row.logo_url!, primaryColor: row.primary_color!, secondaryColor: row.secondary_color }
      : null,
    memberCount: Number(row.member_count),
  };
}
