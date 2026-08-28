import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './Sidebar.js';
import { Header } from './Header.js';
import { PasskeyRegistration } from './PasskeyRegistration.js';
import { KpiRow } from './KpiRow.js';
import { FindingsTable } from './FindingsTable.js';
import { GateFailuresPanel } from './GateFailuresPanel.js';
import { ReviewQueues } from './ReviewQueues.js';
import { RubricConflictQueue } from './RubricConflictQueue.js';
import { RuleProposalQueue } from './RuleProposalQueue.js';
import { ExtractionReview } from './ExtractionReview.js';
import { ContractRubricPreview } from './ContractRubricPreview.js';
import {
  fetchFindings,
  fetchFindingsSummary,
  fetchGateFailures,
  fetchReviewQueues,
  fetchRubricConflicts,
  fetchRuleProposals,
  fetchContractRuleProposalPreviews,
  type FindingRow,
  type FindingsSortDir,
  type FindingsSortKey,
  type FindingsSummary,
  type GateFailureRow,
  type ReviewQueues as ReviewQueuesData,
  type RubricConflict,
  type RuleProposal,
  type ContractRuleProposalPreview,
} from '../lib/api.js';

/**
 * A single combined status for both fetches (86e2urn2t) -- the item allows
 * either per-fetch or combined state, and combined is simpler at this
 * appetite. Both fetches previously discarded their errors silently
 * (.catch(() => setX(defaultValue))), which made a failed request render
 * pixel-identical to a genuinely empty tenant -- FindingsTable's own empty
 * state ("No findings match these filters.") is correct for the latter and
 * stays untouched; this only changes what Dashboard shows BEFORE reaching
 * that point.
 */
type LoadStatus = 'loading' | 'error' | 'ready';

export function Dashboard() {
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [minAmountFilter, setMinAmountFilter] = useState('');
  // 86e2v251e: sort now lives here, not inside FindingsTable -- it drives a
  // server round-trip (the whole point: sort must be correct against the
  // full filtered result set, not just the current 50-row page), so
  // FindingsTable becomes a controlled sort UI that reports clicks upward
  // rather than re-sorting `rows` locally.
  const [sort, setSort] = useState<{ key: FindingsSortKey; dir: FindingsSortDir } | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  // 86e2v17xn: gate failures are fetched SEPARATELY from the summary/findings
  // Promise.all below, deliberately -- a gate-failures fetch failure must not
  // blank the whole dashboard (KPIs + findings table), since it's an
  // additive panel, not core to the existing page. It degrades alone:
  // failing silently just means "no rejected-invoices panel this load,"
  // which is the same visual result as "no rejected invoices exist."
  const [gateFailures, setGateFailures] = useState<GateFailureRow[]>([]);
  const [reviewQueues, setReviewQueues] = useState<ReviewQueuesData>({ escalation: [], unassessable: [] });
  const [rubricConflicts, setRubricConflicts] = useState<RubricConflict[]>([]);
  const [ruleProposals, setRuleProposals] = useState<RuleProposal[]>([]);
  const [contractProposals, setContractProposals] = useState<ContractRuleProposalPreview[]>([]);

  const load = useCallback(() => {
    setStatus('loading');
    Promise.all([
      fetchFindingsSummary(),
      fetchFindings({
        carrier: carrierFilter || undefined,
        status: statusFilter || undefined,
        minAmount: minAmountFilter || undefined,
        sort: sort?.key,
        sortDir: sort?.dir,
      }),
    ]).then(
      ([summaryResult, rowsResult]) => {
        setSummary(summaryResult);
        setRows(rowsResult);
        setStatus('ready');
      },
      () => {
        setStatus('error');
      },
    );
    // 86e2uuw7k: minAmountFilter MUST be in this dependency array -- the same
    // defect class as PR #43's silently-broken filter, where a value used
    // inside the callback but omitted from its deps meant the callback never
    // re-created and the fetch never re-ran with the new value. sort is the
    // same defect class one dimension over.
  }, [carrierFilter, statusFilter, minAmountFilter, sort]);

  function toggleSort(key: FindingsSortKey) {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: 'asc' };
    });
  }

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetchGateFailures().then(setGateFailures, () => setGateFailures([]));
    fetchReviewQueues().then(setReviewQueues, () => setReviewQueues({ escalation: [], unassessable: [] }));
    fetchRubricConflicts().then(setRubricConflicts, () => setRubricConflicts([]));
    fetchRuleProposals().then(setRuleProposals, () => setRuleProposals([]));
    fetchContractRuleProposalPreviews().then(setContractProposals, () => setContractProposals([]));
  }, []);

  return (
    <div className="flex h-screen w-full bg-[#eae9e9] text-[#201e1d]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <PasskeyRegistration />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
          {status === 'loading' && (
            <div data-testid="dashboard-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
              Loading…
            </div>
          )}
          {status === 'error' && (
            <div
              data-testid="dashboard-error"
              className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
            >
              <span>Something went wrong loading the dashboard.</span>
              <button
                type="button"
                onClick={load}
                className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold"
              >
                Retry
              </button>
            </div>
          )}
          {status === 'ready' && (
            <>
              {summary && <KpiRow summary={summary} />}
              <ExtractionReview />
              <GateFailuresPanel rows={gateFailures} />
              <ReviewQueues queues={reviewQueues} />
              <RubricConflictQueue rows={rubricConflicts} />
              <RuleProposalQueue rows={ruleProposals} onRatified={(id, lifecycle) => setRuleProposals((rows) => lifecycle === 'ACTIVE'
                ? rows.filter((r) => r.id !== id) : rows.map((r) => r.id === id ? { ...r, lifecycle_state: 'SHADOW' } : r))} />
              <ContractRubricPreview rows={contractProposals} />
              <FindingsTable
                rows={rows}
                carrierFilter={carrierFilter}
                statusFilter={statusFilter}
                minAmountFilter={minAmountFilter}
                onCarrierFilterChange={setCarrierFilter}
                onStatusFilterChange={setStatusFilter}
                onMinAmountFilterChange={setMinAmountFilter}
                onRowStatusChange={(id, status) =>
                  // 86e2v1xyr: patches the table's copy of the transitioned row so
                  // it doesn't show a stale status until the next filter change
                  // re-fetches. The KPI row is deliberately NOT recomputed here --
                  // its aggregates (recoverableOpen etc.) are server-derived
                  // (findings-summary.ts); re-deriving them client-side would
                  // duplicate that logic and risk drifting from it silently.
                  setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
                }
                sort={sort}
                onSortChange={toggleSort}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
