/**
 * Types mirror the backend's actual response shapes exactly (src/modules/findings/*.ts):
 * - list-findings.ts's FindingRow: camelCase keys, money fields are strings (pg numeric).
 * - findings-summary.ts's FindingsSummary: recoverableOpen/recoveredLast30Days are
 *   strings, flaggedToday/withCarriers are numbers.
 */
export interface FindingRow {
  id: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  /** null when the backing variance_finding has no single charge to attribute the billed amount to (86e2v17p5). */
  billed: string | null;
  expected: string | null;
  varianceAmount: string | null;
  direction: string | null;
  status: string;
  createdAt: string;
  ruleDescription: string | null;
}

export interface FindingsSummary {
  recoverableOpen: string;
  flaggedToday: number;
  withCarriers: number;
  recoveredLast30Days: string;
}

/**
 * 86e2v17xn: a rejected invoice's kickback. Structurally distinct from
 * FindingRow -- no billed/expected/varianceAmount/direction/status fields,
 * since the invoice was rejected before the SCORE phase ever ran.
 */
export interface GateFailureRow {
  id: string;
  auditRunId: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  defect: string;
  citation: string | null;
  recordedAt: string;
}

export type FindingsSortKey = 'variance' | 'age';
export type FindingsSortDir = 'asc' | 'desc';

export interface FindingsListParams {
  carrier?: string;
  status?: string;
  minAmount?: string;
  sort?: FindingsSortKey;
  sortDir?: FindingsSortDir;
}

function buildQuery(params: FindingsListParams): string {
  const qs = new URLSearchParams();
  if (params.carrier) qs.set('carrier', params.carrier);
  if (params.status) qs.set('status', params.status);
  // Backend reads this literally as 'min-amount' (kebab-case), not minAmount.
  if (params.minAmount) qs.set('min-amount', params.minAmount);
  // 86e2v251e: sort is applied server-side (against the full filtered result
  // set, before LIMIT) -- see list-findings.ts's ORDER_COLUMNS. sortDir is
  // only meaningful alongside sort, but sending it standalone is harmless
  // (the backend's default sort column just gets a direction).
  if (params.sort) qs.set('sort', params.sort);
  if (params.sortDir) qs.set('sortDir', params.sortDir);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * Dev-mode-only stub headers (86e2urebj) satisfying tenant-auth.ts's
 * resolveAuthorizedTenantContext contract: a claimed client_id + user_id,
 * no real session. NOT real auth -- see 86e2u7j2y for the deferred
 * credential-scheme decision this explicitly does not make. Single source
 * so both call sites stay in sync rather than duplicating string literals.
 *
 * These two UUIDs MUST match scripts/seed-dev-tenant.mjs's DEV_CLIENT_ID/
 * DEV_USER_ID exactly -- that script inserts the client/app_user/membership
 * rows that make this claimed pair real (membership carries FORCE RLS, so
 * an unseeded pair still 401s even with both headers present). web/'s build
 * doesn't share a module graph with the root scripts/ package, so the
 * values are duplicated here rather than imported -- if you change one,
 * change both.
 *
 * 86e2v24uf: this pair shipped unconditionally into the production bundle --
 * anyone reading the public JS got a live credential pair against the
 * deployed dev environment. Gated behind import.meta.env.DEV (a Vite
 * build-time constant, false in a production build) so it never ships
 * outside a dev/test build.
 *
 * 86e2v1bdj: `vite build` bakes DEV to false unconditionally, so CI's
 * web-fullstack job -- which builds a real production bundle and serves it
 * against a server running with DEV_AUTH_HEADERS=1 -- got a bundle sending no
 * headers, breaking that suite. VITE_DEV_AUTH_HEADERS is a SEPARATE explicit
 * build-time opt-in (only VITE_-prefixed vars reach client code) set ONLY in
 * that CI build step -- a real deploy build never sets it, so this does not
 * reopen the exposure the DEV gate above closes.
 */
function authHeaders(): HeadersInit {
  if (!import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_HEADERS !== '1') return {};
  return {
    'x-client-id': '11111111-1111-1111-1111-111111111111',
    'x-user-id': '22222222-2222-2222-2222-222222222222',
  };
}

export async function fetchFindings(params: FindingsListParams = {}): Promise<FindingRow[]> {
  const res = await fetch(`/api/findings${buildQuery(params)}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET /api/findings failed: ${res.status}`);
  const body = (await res.json()) as { findings: FindingRow[] };
  return body.findings;
}

export async function fetchFindingsSummary(): Promise<FindingsSummary> {
  const res = await fetch('/api/findings/summary', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET /api/findings/summary failed: ${res.status}`);
  return (await res.json()) as FindingsSummary;
}

export async function fetchGateFailures(): Promise<GateFailureRow[]> {
  const res = await fetch('/api/gate-failures', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET /api/gate-failures failed: ${res.status}`);
  const body = (await res.json()) as { gateFailures?: GateFailureRow[] };
  // Defensive against a 200 response missing the key (not just a rejected
  // fetch) -- Dashboard's degrade-alone .catch only covers the reject case;
  // this covers the other half so setGateFailures never receives undefined.
  return body.gateFailures ?? [];
}

/**
 * 86e2v1xyr: the drawer's status control. Scoped server-side to the same 5
 * values the status filter dropdown exposes (open/in_review/
 * queued_for_dispute/disputed/closed) -- see app.ts's WRITABLE_STATUS_VALUES.
 */
export async function updateFindingStatus(id: string, status: string): Promise<void> {
  const res = await fetch(`/api/findings/${id}/status`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`PATCH /api/findings/${id}/status failed: ${res.status}`);
}
