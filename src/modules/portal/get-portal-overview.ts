import type pg from 'pg';

/**
 * Client-facing portal overview (P6.A.1): the minimal tenant identity the
 * portal shell's header renders, and the first tenant-scoped read any
 * portal-facing page makes -- proves the shell resolves through the same
 * RLS-bound tenant scope every other tenant route uses (db/tenant-context.ts),
 * rather than a second, parallel notion of tenant.
 *
 * Deliberately just the client's own name: the portal's actual content
 * views (invoices, findings, disputes, claims, audit log) are P6.B's job.
 * This module exists only to give the shell something real and tenant-scoped
 * to fetch, not to front-run those items' data shapes.
 *
 * Isolation note: migration 0009's tenant_isolation RLS policy applies to
 * tables with a client_id (or equivalent) tenant column -- `client` is the
 * tenant ROOT, not a tenant-scoped leaf, and carries no such policy itself.
 * This function's isolation guarantee therefore comes entirely from its
 * caller (portal-routes.ts) always passing the requester's OWN resolved
 * clientId -- never a client-suppliable parameter. Do not call this with an
 * id sourced from request input.
 */
export async function getPortalOverview(client: pg.PoolClient, clientId: string): Promise<{ clientName: string } | null> {
  const { rows } = await client.query<{ name: string }>(`SELECT name FROM client WHERE id = $1`, [clientId]);
  const row = rows[0];
  return row ? { clientName: row.name } : null;
}
