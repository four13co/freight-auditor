import { devHeaderPathActive } from './dev-auth';

/**
 * Dev-only identity pair. MUST match scripts/seed-dev-tenant.mjs's
 * DEV_CLIENT_ID/DEV_USER_ID exactly -- that script inserts the client/
 * app_user/membership rows that make this claimed pair real (membership
 * carries FORCE RLS, so an unseeded pair still 401s even with both headers
 * present).
 *
 * Gated behind devHeaderPathActive() (import.meta.env.DEV, or
 * VITE_DEV_AUTH_HEADERS==='1' for CI's web-fullstack job) so a real
 * production build folds this branch away at build time -- these values
 * never ship in a deploy bundle.
 */
const DEV_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DEV_USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Set once fetchAndStoreClientId() resolves, on the real-session path only.
 * sessionStorage (not localStorage) so a stale client_id from a previous,
 * now-signed-out session in the same tab never outlives that session -- a
 * fresh sign-in re-fetches and re-stores it.
 */
export const CLIENT_ID_STORAGE_KEY = 'freight-auditor:client-id';

export function authHeaders(): HeadersInit {
  if (!devHeaderPathActive()) {
    // Real-session path: the backend derives identity from the session
    // cookie itself. Only x-client-id is sent, and only once App has
    // fetched and stored it; absent that, no header is sent and the
    // backend fails closed (401).
    const clientId = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    return clientId ? { 'x-client-id': clientId } : {};
  }
  return {
    'x-client-id': DEV_CLIENT_ID,
    'x-user-id': DEV_USER_ID,
  };
}

/**
 * Called once by AuthProvider after a real (non-dev-header) session is
 * established, so subsequent requests' authHeaders() has a client_id to
 * send. Single-membership-per-user only. Fails closed: a user with zero
 * memberships (or a failed lookup) stores nothing, so authHeaders() sends
 * no x-client-id and the backend fails closed, rather than this throwing
 * and blocking the app render.
 */
export async function fetchAndStoreClientId(): Promise<void> {
  const res = await fetch('/api/auth/memberships');
  if (!res.ok) return;
  const body = (await res.json()) as { clientIds: string[] };
  if (body.clientIds[0]) sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, body.clientIds[0]);
}

/**
 * The actor-type half of GET /api/auth/memberships' response.
 * isInternal===true means an app_user.is_internal analyst; otherwise role
 * is the backend's portal membership role (currently 'client_viewer' /
 * 'client_admin' -- see the Uncertainties note in this PR's body about the
 * gap between that vocabulary and this item's employee/client/grand_client/
 * vendor role model).
 *
 * Fails closed the same way fetchAndStoreClientId does: an unresolved
 * lookup never claims isInternal, and a 200 with a non-JSON body would
 * otherwise throw out of res.json() -- caught here.
 */
export interface ActorContext {
  isInternal: boolean;
  role: string | null;
  clientName: string | null;
}

export interface TenantOption {
  id: string;
  name: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
}

/**
 * Full tenant rows (id/name/slug/isActive/createdAt) from the same
 * GET /api/internal/tenants endpoint fetchClients() calls -- that function
 * only projects {id, name} for TenantPicker's combobox. This one keeps the
 * fields the Employee Clients/Users pages need (86e3a6rde/re6). One page
 * fetch (limit 100, matching fetchClients' own cap) rather than paging
 * through the whole tenant list -- fine for this epic's data volume; a
 * genuinely large tenant count would need real pagination wired through
 * the page, tracked as a future gap alongside the others in this epic.
 */
export async function fetchTenantSummaries(): Promise<TenantSummary[]> {
  try {
    const res = await fetch('/api/internal/tenants?limit=100', { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      tenants?: { id: string; name: string; slug: string; isActive: boolean; createdAt: string }[];
    };
    return (body.tenants ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      isActive: t.isActive,
      createdAt: t.createdAt,
    }));
  } catch {
    return [];
  }
}

/**
 * Backs the Employee-only branch of TenantPicker (86e3a6rak): GET
 * /api/internal/tenants is gated to internal actors server-side, so this
 * always 403s for a non-employee caller -- TenantProvider only calls it
 * when role === 'employee'. There is no equivalent "my Grand Clients"
 * endpoint yet (the backend has no Grand Client concept at all -- see this
 * PR's Uncertainties), so Client/Grand Client/Vendor have nothing to fetch.
 */
export async function fetchClients(): Promise<TenantOption[]> {
  try {
    const res = await fetch('/api/internal/tenants?limit=100', { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { tenants?: { id: string; name: string }[] };
    return (body.tenants ?? []).map((t) => ({ id: t.id, name: t.name }));
  } catch {
    return [];
  }
}

/** Backend membership roles (tenant-admin-routes.ts's MEMBERSHIP_ROLES) -- the real role vocabulary today. */
export const MEMBERSHIP_ROLES = ['analyst', 'lead', 'client_viewer', 'client_admin'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export interface TenantMember {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: MembershipRole;
  createdAt: string;
}

export interface UserRow extends TenantMember {
  tenantId: string;
  tenantName: string;
  tenantIsActive: boolean;
}

/**
 * 86e3a6rde: GET /api/internal/tenants/:id/members -- real, but scoped to
 * ONE tenant and not paginated (listTenantMembers.ts returns every row for
 * that tenant). There is no cross-tenant "all users" endpoint.
 */
export async function fetchTenantMembers(tenantId: string): Promise<TenantMember[]> {
  try {
    const res = await fetch(`/api/internal/tenants/${tenantId}/members`, { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { members?: TenantMember[] };
    return body.members ?? [];
  } catch {
    return [];
  }
}

/**
 * 86e3a6rde's "global user management across all tenants" AC has no single
 * backend endpoint behind it -- built here as tenants-then-members fan-out
 * over the two real endpoints that do exist. This means UsersPage's
 * pagination/sort/filter run client-side over this aggregate, not
 * server-side over a combined query; see UsersPage's own Uncertainties.
 */
export async function fetchAllUsers(): Promise<UserRow[]> {
  const tenants = await fetchTenantSummaries();
  const perTenant = await Promise.all(
    tenants.map(async (tenant) => {
      const members = await fetchTenantMembers(tenant.id);
      return members.map((member) => ({
        ...member,
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantIsActive: tenant.isActive,
      }));
    }),
  );
  return perTenant.flat();
}

export async function createTenantMember(
  tenantId: string,
  input: { email: string; fullName?: string | null; role: MembershipRole },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/members`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
}

export async function deleteTenantMember(tenantId: string, membershipId: string): Promise<boolean> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/members/${membershipId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return res.ok;
}

export async function fetchActorContext(): Promise<ActorContext> {
  const res = await fetch('/api/auth/memberships');
  if (!res.ok) return { isInternal: false, role: null, clientName: null };
  try {
    const body = (await res.json()) as {
      isInternal?: boolean;
      role?: string | null;
      clientName?: string | null;
    };
    return {
      isInternal: body.isInternal === true,
      role: body.role ?? null,
      clientName: body.clientName ?? null,
    };
  } catch {
    return { isInternal: false, role: null, clientName: null };
  }
}
