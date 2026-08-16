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
  billed: string;
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

export interface FindingsListParams {
  carrier?: string;
  status?: string;
  minAmount?: string;
}

function buildQuery(params: FindingsListParams): string {
  const qs = new URLSearchParams();
  if (params.carrier) qs.set('carrier', params.carrier);
  if (params.status) qs.set('status', params.status);
  // Backend reads this literally as 'min-amount' (kebab-case), not minAmount.
  if (params.minAmount) qs.set('min-amount', params.minAmount);
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
 */
function authHeaders(): HeadersInit {
  return {
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
