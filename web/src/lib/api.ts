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
 * 86e3a6rgc/rgu/rh4/rhj/rhv/rj8/rjr (Client UI epic): the Client role's own
 * client id, for scoping the shared in-memory-hierarchy-store (`client:<id>`)
 * and for any page that needs it directly -- same two sources authHeaders()
 * already reads (the dev-header pair, or the real-session sessionStorage
 * value fetchAndStoreClientId() populates), just exposed for callers that
 * need the id itself rather than a ready-made headers object.
 */
export function getOwnClientId(): string | null {
  if (!devHeaderPathActive()) return sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  return DEV_CLIENT_ID;
}

/**
 * The actor-type half of GET /api/auth/memberships' response.
 * isInternal===true means an app_user.is_internal analyst; otherwise role
 * is the backend's portal membership role (currently 'client_viewer' /
 * 'client_admin' -- see the Uncertainties note in this PR's body about the
 * gap between that vocabulary and this item's employee/account/grand_client/
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

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || `client-${Date.now()}`
  );
}

export async function createClient(
  input: { name: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch('/api/internal/tenants', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, slug: slugify(input.name) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
}

export async function updateClient(
  tenantId: string,
  patch: { name?: string; isActive?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/internal/tenants/${tenantId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
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
  /** membership.is_active (the per-row toggle), not the tenant's own isActive. */
  isActive: boolean;
}

interface AllTenantMembersPage {
  members: {
    id: string;
    userId: string;
    email: string;
    fullName: string | null;
    role: MembershipRole;
    isActive: boolean;
    clientId: string;
    clientName: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

/**
 * 86e3a7d57: replaces the old tenants-then-members client-side fan-out (GET
 * /api/internal/tenants, capped at limit=100, then GET
 * /api/internal/tenants/:id/members per tenant -- silently dropping any
 * tenant past the 100th) with the cross-tenant paginated
 * GET /api/internal/members endpoint (list-all-tenant-members.ts), paging
 * via its opaque keyset cursor until nextCursor is null so every tenant's
 * members are represented regardless of tenant count.
 */
export async function fetchAllUsers(): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = cursor ? `/api/internal/members?cursor=${encodeURIComponent(cursor)}` : '/api/internal/members';
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) break;
    const body = (await res.json()) as AllTenantMembersPage;
    for (const m of body.members) {
      rows.push({
        membershipId: m.id,
        userId: m.userId,
        email: m.email,
        fullName: m.fullName,
        role: m.role,
        isActive: m.isActive,
        tenantId: m.clientId,
        tenantName: m.clientName,
        createdAt: m.createdAt,
      });
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return rows;
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

/** Edit role and/or toggle enable/disable on an existing tenant membership (86e3a7d57). */
export async function updateTenantMember(
  tenantId: string,
  membershipId: string,
  patch: { role?: MembershipRole; isActive?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/members/${membershipId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
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

// ---- Rules & Rates (86e3a6rg1) --------------------------------------------

export type RuleTier = 'STANDARD' | 'CLIENT' | 'CONTRACT';
export type RuleKind = 'GATING' | 'SCORING';
export type RuleLifecycle = 'PROPOSED' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'QUARANTINED';
export type RuleListSortKey = 'name' | 'tier' | 'type' | 'status' | 'lastModified';

export interface RuleRow {
  ruleVersionId: string;
  ruleId: string;
  slug: string;
  ruleType: string;
  tier: RuleTier | null;
  kind: RuleKind | null;
  status: RuleLifecycle;
  hardness: string;
  lastModified: string;
}

export interface RuleListParams {
  tier?: RuleTier;
  kind?: RuleKind;
  status?: RuleLifecycle;
  sortKey?: RuleListSortKey;
  sortDirection?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface RuleListResult {
  rows: RuleRow[];
  total: number;
}

export interface RulePromotionEvent {
  id: string;
  fromLifecycle: string | null;
  toLifecycle: string | null;
  direction: string;
  rationale: string | null;
  recordedAt: string;
}

export interface RuleDetail extends RuleRow {
  emits: string;
  ast: unknown;
  expectedInputs: unknown;
  provenance: unknown;
  clauseId: string | null;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  history: RulePromotionEvent[];
}

/**
 * The Rules tab's list -- server-side filter/sort/pagination, unlike
 * UsersPage's client-side DataTable use (see rule-governance-routes.ts's
 * GET /api/rules for why: this list is expected to grow far larger than
 * this epic's other tables, per the task's own AC).
 */
export async function fetchRules(params: RuleListParams): Promise<RuleListResult> {
  const search = new URLSearchParams();
  if (params.tier) search.set('tier', params.tier);
  if (params.kind) search.set('kind', params.kind);
  if (params.status) search.set('status', params.status);
  if (params.sortKey) search.set('sortKey', params.sortKey);
  if (params.sortDirection) search.set('sortDirection', params.sortDirection);
  search.set('limit', String(params.limit));
  search.set('offset', String(params.offset));

  const res = await fetch(`/api/rules?${search.toString()}`, { headers: authHeaders() });
  if (!res.ok) return { rows: [], total: 0 };
  return (await res.json()) as RuleListResult;
}

export async function fetchRuleDetail(ruleVersionId: string): Promise<RuleDetail | null> {
  const res = await fetch(`/api/rules/${ruleVersionId}`, { headers: authHeaders() });
  if (!res.ok) return null;
  return (await res.json()) as RuleDetail;
}

async function transitionRule(
  ruleVersionId: string,
  action: 'ratify' | 'activate' | 'deprecate' | 'quarantine',
  rationale: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/rules/${ruleVersionId}/${action}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rationale }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
}

export const ratifyRule = (id: string, rationale: string) => transitionRule(id, 'ratify', rationale);
export const activateRule = (id: string, rationale: string) => transitionRule(id, 'activate', rationale);
export const deprecateRule = (id: string, rationale: string) => transitionRule(id, 'deprecate', rationale);
export const quarantineRule = (id: string, rationale: string) => transitionRule(id, 'quarantine', rationale);

export interface ContractVersionOption {
  contractVersionId: string;
  contractId: string;
  contractName: string;
  versionLabel: string | null;
  validFrom: string;
  validTo: string | null;
}

export async function fetchContractVersions(tenantId: string): Promise<ContractVersionOption[]> {
  try {
    const res = await fetch(`/api/internal/tenants/${tenantId}/contract-versions`, { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { contractVersions?: ContractVersionOption[] };
    return body.contractVersions ?? [];
  } catch {
    return [];
  }
}

export interface ContractRateRow {
  id: string;
  contractVersionId: string;
  contractId: string;
  contractName: string;
  versionLabel: string | null;
  category: string;
  amount: string;
  currency: string;
  clauseId: string | null;
  createdAt: string;
}

export async function fetchContractRates(tenantId: string): Promise<ContractRateRow[]> {
  try {
    const res = await fetch(`/api/internal/tenants/${tenantId}/rates`, { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { rates?: ContractRateRow[] };
    return body.rates ?? [];
  } catch {
    return [];
  }
}

export async function createContractRate(
  tenantId: string,
  input: { contractVersionId: string; category: string; amount: string; currency: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/rates`, {
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

export async function updateContractRate(
  tenantId: string,
  rateId: string,
  patch: { category?: string; amount?: string; currency?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/rates/${rateId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
}

export async function deleteContractRate(tenantId: string, rateId: string): Promise<boolean> {
  const res = await fetch(`/api/internal/tenants/${tenantId}/rates/${rateId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return res.ok;
}

// ---- Client portal self-service members (86e3a6rgu) -----------------------

/**
 * One row of the client's own portal roster -- GET /api/portal/members
 * (portal-admin-routes.ts), available to client_viewer or client_admin,
 * scoped server-side to the caller's own client_id via requireSingleClientId.
 * Deliberately thin: no fullName/status/lastLogin columns exist on this
 * endpoint (list-portal-members.ts's PortalMemberRow is
 * id/userId/email/role/createdAt only) -- rendered as-is rather than
 * fabricated, see UsersPage's own Uncertainties.
 */
export interface PortalMember {
  id: string;
  userId: string;
  email: string;
  role: 'client_viewer' | 'client_admin';
  createdAt: string;
}

export async function fetchPortalMembers(): Promise<PortalMember[]> {
  try {
    const res = await fetch('/api/portal/members?limit=200', { headers: authHeaders() });
    if (!res.ok) return [];
    const body = (await res.json()) as { members?: PortalMember[] };
    return body.members ?? [];
  } catch {
    return [];
  }
}

/**
 * PATCH /api/portal/members/:id/role -- client_admin only server-side
 * (registerClientAdminAuthPreHandler); a client_viewer's attempt 403s and
 * this surfaces that error via the same {ok:false, error} shape as every
 * other write in this file, rather than trying to pre-guess the caller's
 * own role client-side (AuthUser.role is the coarse 'account' bucket only --
 * see the role-vocab-gap note in auth-provider.tsx).
 */
export async function updatePortalMemberRole(
  membershipId: string,
  role: 'client_viewer' | 'client_admin',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/portal/members/${membershipId}/role`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `request failed (${res.status})` };
  }
  return { ok: true };
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
