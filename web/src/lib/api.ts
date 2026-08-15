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

export async function fetchFindings(params: FindingsListParams = {}): Promise<FindingRow[]> {
  const res = await fetch(`/api/findings${buildQuery(params)}`);
  if (!res.ok) throw new Error(`GET /api/findings failed: ${res.status}`);
  const body = (await res.json()) as { findings: FindingRow[] };
  return body.findings;
}

export async function fetchFindingsSummary(): Promise<FindingsSummary> {
  const res = await fetch('/api/findings/summary');
  if (!res.ok) throw new Error(`GET /api/findings/summary failed: ${res.status}`);
  return (await res.json()) as FindingsSummary;
}
