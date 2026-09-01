import { devHeaderPathActive } from './dev-auth.js';

/**
 * Types mirror the backend's actual response shapes exactly (src/modules/findings/*.ts):
 * - list-findings.ts's FindingRow: camelCase keys, money fields are strings (pg numeric).
 * - findings-summary.ts's FindingsSummary: recoverableOpen/recoveredLast30Days are
 *   strings, flaggedToday/withCarriers are numbers.
 */
export interface FindingRow {
  id: string;
  auditRunId?: string;
  invoiceId?: string;
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

export interface InvoiceScorecard {
  audit_run_id: string; invoice_id: string; invoice_number: string | null; outcome: string;
  conformed_count: number | null; variance_count: number | null; unassessable_count: number | null;
  total_overcharge: string | null; total_undercharge: string | null; currency: string | null;
}
export interface FindingProvenance {
  finding: { evaluatedExpr: unknown }; criterion: { key: string }; ruleVersion: { astHash: string };
  clause: { id: string; reference: string; page: string | null } | null;
  rateCell: { id: string; reference: string } | null;
  sourceDocument: { id: string; sha256: string; storageUri: string } | null;
}
export interface ReviewQueueItem { id: string; auditRunId: string; invoiceNumber: string | null; criterionKey: string; createdAt: string }
export interface ReviewQueues { escalation: ReviewQueueItem[]; unassessable: ReviewQueueItem[] }
export interface RubricConflict { id: string; criterion_key: string | null; conflict_type: string; detail: Record<string, unknown>; recorded_at: string }
export interface RuleProposal { id: string; slug: string; rule_type: string; hardness: string; lifecycle_state: 'PROPOSED' | 'SHADOW'; ast_hash: string; recorded_at: string }
export interface ContractRuleProposalPreview {
  id: string; verifiedContractVersionId: string; contractName: string; criterionKey: string; ruleType: string;
  description: string; ast: unknown; astHash: string; expectedInputs: string[]; lifecycleState: 'PROPOSED';
  modelId: string; promptVersion: string; sourceDocumentSha256: string; extractionResponseHash: string;
  verificationHash: string; recordedAt: string;
  clauses: Array<{ clauseId: string; clauseRef: string; textExcerpt: string | null; pageRef: string | null; citations: unknown[] }>;
  backtest: { id: string; passed: boolean; passCount: number; regressionCount: number; corpusHash: string; recordedAt: string } | null;
  baseline: { ast: unknown; astHash: string; description: string | null } | null;
  acceptance: { id: string; shadowRuleVersionId: string; acceptedBy: string; rationale: string; recordedAt: string } | null;
  ratification: { id: string; activeRuleVersionId: string; ratifiedBy: string; rationale: string; recordedAt: string } | null;
  diff: { status: 'NEW' | 'UNCHANGED' | 'CHANGED'; astChanged: boolean; descriptionChanged: boolean };
}
export type ClarificationAnswerSource = 'read_from_doc' | 'analyst_knowledge' | 'carrier_confirmed';
export interface ClarifyingQuestion {
  id: string;
  source_document_id: string;
  field_path: string;
  question: string;
  answer: string | null;
  answer_source: ClarificationAnswerSource | null;
  abstention_status: 'NOT_FOUND' | 'AMBIGUOUS';
  abstention_reason: string;
  policy_version: string;
  question_hash: string;
  created_at: string;
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
  criterionKey?: string;
  evaluatedExpr?: unknown;
  clauseReference?: string | null;
  sourceDocumentId?: string | null;
  transportDocumentId?: string | null;
}

export interface PendingPaymentAuthorizationRow {
  auditRunId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  currency: string | null;
  heldAt: string;
  rationale: string | null;
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
 *
 * 86e2xcnw5: the DEV/VITE_DEV_AUTH_HEADERS check itself is now the one
 * shared devHeaderPathActive() predicate (lib/dev-auth.ts) -- this file and
 * App.tsx used to each encode it as a separate expression (this file's own
 * negated form).
 */
/**
 * 86e2wb92b: the storage key App.tsx writes to after fetching
 * /api/auth/memberships post-login, and authHeaders() below reads from on
 * every subsequent request. sessionStorage (not localStorage) so a stale
 * client_id from a previous, now-signed-out session in the same tab never
 * outlives that session -- a fresh sign-in re-fetches and re-stores it.
 */
export const CLIENT_ID_STORAGE_KEY = 'freight-auditor:client-id';

function authHeaders(): HeadersInit {
  if (!devHeaderPathActive()) {
    // 86e2wb92b: the real-session path. resolveViaSession (tenant-auth.ts)
    // derives the user from the session cookie itself, not from a header --
    // sending x-user-id here would be a client-controlled value the backend
    // never reads, easily mistaken for an identity-spoofing vector. Only
    // x-client-id is sent, and only once App.tsx has fetched and stored it;
    // absent that, no header is sent and the backend fails closed (401).
    const clientId = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    return clientId ? { 'x-client-id': clientId } : {};
  }
  return {
    'x-client-id': '11111111-1111-1111-1111-111111111111',
    'x-user-id': '22222222-2222-2222-2222-222222222222',
  };
}

/**
 * 86e2wb92b: called once by App.tsx after a real (non-dev-header) session is
 * established, so subsequent requests' authHeaders() has a client_id to
 * send. Single-membership-per-user only (see the item's No-gos) -- the
 * first client_id returned wins; a user with zero memberships stores
 * nothing, so authHeaders() sends no x-client-id and the backend fails
 * closed (AC3), rather than this throwing and blocking the dashboard render.
 */
export async function fetchAndStoreClientId(): Promise<void> {
  const res = await fetch('/api/auth/memberships');
  if (!res.ok) return;
  const body = (await res.json()) as { clientIds: string[] };
  if (body.clientIds[0]) sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, body.clientIds[0]);
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
export async function fetchReviewQueues(): Promise<ReviewQueues> {
  const res = await fetch('/api/findings/queues', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET review queues failed: ${res.status}`);
  const body = (await res.json()) as Partial<ReviewQueues>;
  return { escalation: body.escalation ?? [], unassessable: body.unassessable ?? [] };
}
export async function fetchRubricConflicts(): Promise<RubricConflict[]> {
  const res = await fetch('/api/rubric-conflicts', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET rubric conflicts failed: ${res.status}`);
  const body = (await res.json()) as { conflicts?: RubricConflict[] };
  return body.conflicts ?? [];
}
export async function fetchRuleProposals(): Promise<RuleProposal[]> {
  const res = await fetch('/api/rules/proposals', { headers: authHeaders() }); if (!res.ok) throw new Error('GET proposals failed');
  return ((await res.json()) as { proposals?: RuleProposal[] }).proposals ?? [];
}
export async function fetchContractRuleProposalPreviews(): Promise<ContractRuleProposalPreview[]> {
  const res = await fetch('/api/contracts/rule-proposal-previews', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET contract rule proposal previews failed: ${res.status}`);
  return ((await res.json()) as { proposals?: ContractRuleProposalPreview[] }).proposals ?? [];
}
export async function acceptContractRuleProposal(id: string, backtestId: string, rationale: string): Promise<{ shadowRuleVersionId: string }> {
  const res = await fetch(`/api/contracts/rule-proposals/${id}/accept`, { method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ backtestId, rationale }) });
  if (!res.ok) throw new Error(`POST contract rule proposal acceptance failed: ${res.status}`);
  return (await res.json()) as { shadowRuleVersionId: string };
}
export async function ratifyContractRuleProposal(acceptanceId:string,rationale:string):Promise<{activeRuleVersionId:string}>{const res=await fetch(`/api/contracts/rule-proposal-acceptances/${acceptanceId}/ratify`,{method:'POST',headers:{...authHeaders(),'content-type':'application/json'},body:JSON.stringify({rationale})});if(!res.ok)throw new Error(`POST contract rule proposal ratification failed: ${res.status}`);return await res.json() as {activeRuleVersionId:string};}
export async function ratifyRuleProposal(id: string, rationale: string): Promise<void> {
  const res = await fetch(`/api/rules/${id}/ratify`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ rationale }) });
  if (!res.ok) throw new Error('POST ratify failed');
}
export async function activateShadowRule(id: string, rationale: string): Promise<void> {
  const res = await fetch(`/api/rules/${id}/activate`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ rationale }) });
  if (!res.ok) throw new Error('POST activate failed');
}

export async function fetchPendingPaymentAuthorizations(): Promise<PendingPaymentAuthorizationRow[]> {
  const res = await fetch('/api/payment-authorizations/pending', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET /api/payment-authorizations/pending failed: ${res.status}`);
  const body = (await res.json()) as { pending?: PendingPaymentAuthorizationRow[] };
  return body.pending ?? [];
}
export async function submitPaymentAuthorization(auditRunId: string, action: 'approve' | 'hold', rationale?: string): Promise<void> {
  const res = await fetch(`/api/audit-runs/${auditRunId}/payment-authorization`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ action, rationale }),
  });
  if (!res.ok) throw new Error(`POST payment authorization failed: ${res.status}`);
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
export async function applyFindingAction(id: string, action: 'accept' | 'waive' | 'escalate'): Promise<{ status: string }> {
  const res = await fetch(`/api/findings/${id}/action`, { method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  if (!res.ok) throw new Error(`POST finding action failed: ${res.status}`);
  return (await res.json()) as { status: string };
}

export async function fetchInvoiceScorecard(auditRunId: string): Promise<InvoiceScorecard> {
  const res = await fetch(`/api/audit-runs/${auditRunId}/scorecard`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET scorecard failed: ${res.status}`);
  return (await res.json()) as InvoiceScorecard;
}

export async function fetchFindingProvenance(id: string): Promise<FindingProvenance> {
  const res = await fetch(`/api/findings/${id}/provenance`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET finding provenance failed: ${res.status}`);
  return (await res.json()) as FindingProvenance;
}

export async function fetchClarifyingQuestions(sourceDocumentId: string): Promise<ClarifyingQuestion[]> {
  const query = new URLSearchParams({ source_document_id: sourceDocumentId });
  const res = await fetch(`/api/clarifying-questions?${query}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET clarifying questions failed: ${res.status}`);
  return ((await res.json()) as { questions: ClarifyingQuestion[] }).questions;
}

export async function answerClarifyingQuestion(
  id: string,
  answer: string,
  answerSource: ClarificationAnswerSource,
): Promise<{ id: string; answer: string; answer_source: ClarificationAnswerSource; changed: boolean }> {
  const res = await fetch(`/api/clarifying-questions/${id}/answer`, {
    method: 'PUT', headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ answer, answer_source: answerSource }),
  });
  if (!res.ok) throw new Error(`PUT clarification answer failed: ${res.status}`);
  return (await res.json()) as { id: string; answer: string; answer_source: ClarificationAnswerSource; changed: boolean };
}

/**
 * Mirrors #181's get-claim-detail.ts ClaimDetail shape exactly: camelCase
 * keys, money fields as strings (pg numeric), Date fields serialize to ISO
 * strings over the wire. recoveryEvents is the claim's full append-only
 * history -- the endpoint returns detail + history in one response, so
 * there is no separate history fetch.
 */
export interface RecoveryEventRow {
  id: string;
  amountRecovered: string;
  currency: string | null;
  varianceFindingId: string | null;
  recordedAt: string;
}
export interface ClaimDetail {
  id: string;
  disputeId: string | null;
  amountClaimed: string;
  currency: string | null;
  status: string;
  openedAt: string;
  agingDeadlineAt: string | null;
  recoveryEvents: RecoveryEventRow[];
  cumulativeRecovered: string;
}

export async function fetchClaimDetail(id: string): Promise<ClaimDetail> {
  const res = await fetch(`/api/claims/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET claim detail failed: ${res.status}`);
  return (await res.json()) as ClaimDetail;
}

/** Mirrors get-dispute-detail.ts's DisputeDetail shape exactly: camelCase keys, money fields as strings, createdAt as an ISO string over the wire. */
export interface DisputeLineRow {
  id: string;
  varianceFindingId: string | null;
  amount: string | null;
  currency: string | null;
}
export interface DisputeDetail {
  id: string;
  carrierId: string | null;
  status: string;
  amountClaimed: string | null;
  currency: string | null;
  createdAt: string;
  lines: DisputeLineRow[];
}

export async function fetchDisputeDetail(id: string): Promise<DisputeDetail> {
  const res = await fetch(`/api/disputes/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET dispute detail failed: ${res.status}`);
  return (await res.json()) as DisputeDetail;
}

export async function approveDispute(id: string): Promise<{ disputeId: string; status: string }> {
  const res = await fetch(`/api/disputes/${id}/approve`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`POST dispute approval failed: ${res.status}`);
  return (await res.json()) as { disputeId: string; status: string };
}

export interface CrossClientPortfolioBucket {
  clientId: string;
  clientName: string | null;
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  nullCurrencyRecovered: string;
  mismatchedCurrencyRecovered: string;
  reconciles: boolean;
}

export async function fetchCrossClientPortfolio(): Promise<CrossClientPortfolioBucket[]> {
  const res = await fetch('/api/portfolio/cross-client-recovery', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET cross-client portfolio failed: ${res.status}`);
  return ((await res.json()) as { buckets: CrossClientPortfolioBucket[] }).buckets;
}

export interface ClientPortalInvoiceRow {
  id: string;
  invoiceNumber: string | null;
  carrierId: string | null;
  carrierName: string | null;
  currency: string | null;
  status: string;
  createdAt: string;
}

/** Client portal (P6.B.1) -- unwired to nav, same disclosure as PortfolioReport.tsx's own precedent. */
export async function fetchClientPortalInvoices(): Promise<ClientPortalInvoiceRow[]> {
  const res = await fetch('/api/portal/invoices', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET portal invoices failed: ${res.status}`);
  return ((await res.json()) as { invoices: ClientPortalInvoiceRow[] }).invoices;
}

export interface ClientPortalScorecardBucket {
  currency: string | null;
  runCount: number;
  conformedCount: number;
  varianceCount: number;
  unassessableCount: number;
  totalOvercharge: string;
  totalUndercharge: string;
}

/** Client portal (P6.B.1) -- unwired to nav, same disclosure as PortfolioReport.tsx's own precedent. */
export async function fetchClientPortalScorecard(): Promise<ClientPortalScorecardBucket[]> {
  const res = await fetch('/api/portal/scorecard', { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET portal scorecard failed: ${res.status}`);
  return ((await res.json()) as { buckets: ClientPortalScorecardBucket[] }).buckets;
}
