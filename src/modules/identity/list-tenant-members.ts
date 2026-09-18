import type pg from 'pg';

export interface TenantMemberRow {
  id: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  createdAt: Date;
}

/**
 * 86e38rdnm: the tenant-admin member roster -- ALL membership roles
 * (analyst/lead/client_viewer/client_admin), unlike list-portal-members.ts's
 * deliberate PORTAL_ROLES-only filter (that endpoint is client-facing; this
 * one is the internal admin's own view of who has access to a tenant, any
 * role). Runs inside the caller's withTenantTx ({ internal: true }) --
 * membership carries FORCE RLS, so app_is_internal() is what admits rows for
 * a tenant the caller has no membership in themselves.
 */
export async function listTenantMembers(client: pg.PoolClient, clientId: string): Promise<TenantMemberRow[]> {
  const { rows } = await client.query<{
    id: string; user_id: string; email: string; full_name: string | null; role: string; created_at: Date;
  }>(
    `SELECT membership.id, membership.user_id, app_user.email, app_user.full_name, membership.role, membership.created_at
       FROM membership
       JOIN app_user ON app_user.id = membership.user_id
      WHERE membership.account_id = $1
      ORDER BY membership.created_at DESC, membership.id ASC`,
    [clientId],
  );

  return rows.map((r) => ({ id: r.id, userId: r.user_id, email: r.email, fullName: r.full_name, role: r.role, createdAt: r.created_at }));
}
