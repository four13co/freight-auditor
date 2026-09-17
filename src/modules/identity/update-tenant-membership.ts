import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export interface UpdateTenantMembershipInput {
  role?: string;
  isActive?: boolean;
}

export type UpdateTenantMembershipResult =
  | { found: true; id: string; role: string; isActive: boolean }
  | { found: false };

/**
 * 86e3a75mf: internal-admin edit of an existing tenant membership (role
 * and/or is_active). Distinct from update-portal-member-role.ts (the portal
 * surface, restricted to client_viewer/client_admin, single-tenant caller,
 * RLS-scoped) -- this is the internal-admin surface reached via
 * tenant-admin-auth.ts's {internal: true} context. `app_is_internal()`
 * admits every row regardless of client_id for an internal caller
 * (migrations/0009_rls_policies.sql), so RLS gives this query no cross-tenant
 * protection the way it does update-portal-member-role.ts -- the explicit
 * `client_id = $2` in this UPDATE's own WHERE clause IS the boundary here,
 * same convention remove-membership.ts already relies on for this same
 * internal surface.
 *
 * `role` is validated by the caller against the existing membership_role
 * enum at the route boundary (tenant-admin-routes.ts's MEMBERSHIP_ROLES),
 * never accepted here as an arbitrary string.
 *
 * Only a role change writes an audit event (mirroring
 * update-portal-member-role.ts's membership.role_changed_to_<role>
 * convention) -- an is_active-only toggle does not, matching
 * update-client.ts's existing precedent for client.is_active (a boolean
 * flag toggle with no audit trail requirement in this codebase).
 */
export async function updateTenantMembership(
  client: pg.PoolClient,
  clientId: string,
  membershipId: string,
  input: UpdateTenantMembershipInput,
  actorUserId: string | undefined,
): Promise<UpdateTenantMembershipResult> {
  const sets: string[] = [];
  const params: unknown[] = [membershipId, clientId];

  if (input.role !== undefined) {
    params.push(input.role);
    sets.push(`role = $${params.length}::membership_role`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    sets.push(`is_active = $${params.length}`);
  }

  if (sets.length === 0) {
    const { rows } = await client.query<{ id: string; role: string; is_active: boolean }>(
      `SELECT id, role, is_active FROM membership WHERE id = $1 AND client_id = $2`,
      [membershipId, clientId],
    );
    const row = rows[0];
    return row ? { found: true, id: row.id, role: row.role, isActive: row.is_active } : { found: false };
  }

  const result = await client.query<{
    id: string; client_id: string; role: string; is_active: boolean; from_role: string;
  }>(
    `WITH old AS (
       SELECT id, client_id, role AS from_role
         FROM membership
        WHERE id = $1 AND client_id = $2
     ),
     updated AS (
       UPDATE membership
          SET ${sets.join(', ')}
        WHERE id = (SELECT id FROM old)
        RETURNING id, client_id, role, is_active
     )
     SELECT updated.id, updated.client_id, updated.role, updated.is_active, (SELECT from_role FROM old) AS from_role
       FROM updated`,
    params,
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  if (input.role !== undefined && input.role !== row.from_role) {
    const event = `membership.role_changed_to_${row.role}`;
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(row.client_id, row.id, event),
      clientId: row.client_id,
      entity: 'membership',
      entityId: row.id,
      event,
      actorKind: 'analyst',
      actorUserId: actorUserId ?? null,
      detail: { fromRole: row.from_role, toRole: row.role },
    });
  }

  return { found: true, id: row.id, role: row.role, isActive: row.is_active };
}
