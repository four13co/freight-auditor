import { useEffect, useState, type ReactNode } from 'react';
import { fetchFindingProvenance, fetchInvoiceScorecard, updateFindingStatus, type FindingProvenance, type FindingRow, type InvoiceScorecard } from '../lib/api.js';
import { formatMoney, formatVariance } from '../lib/format.js';
import { getStatusDisplay, titleCase } from '../lib/status-display.js';
import { WRITABLE_VARIANCE_STATUSES } from '../../../src/shared/variance-status.js';

/**
 * 86e2v1xyr: the drawer's writable status set -- scoped to exactly the 5
 * values the status FILTER dropdown exposes (FindingsTable.tsx), so a
 * finding can never land on a status the filter can't select. Matches
 * app.ts's WRITABLE_STATUS_VALUES -- both now derive from the one shared
 * source (86e2v892h) rather than hand-maintaining separate literals.
 */
const WRITABLE_STATUSES = WRITABLE_VARIANCE_STATUSES;

/**
 * Human-readable label for FindingRow.direction (86e2uv1tb). The header pill
 * (getStatusDisplay) already surfaces status/direction information in
 * polished form -- this only covers the raw enum leak in the Direction body
 * field itself. INTEGRITY_ONLY gets a demo-appropriate label rather than the
 * generic title-cased fallback, since "Integrity Only" reads as an internal
 * implementation detail, not something a client-facing drawer should show.
 */
const DIRECTION_LABELS: Record<string, string> = {
  OVERCHARGE: 'Overcharge',
  UNDERCHARGE: 'Undercharge',
  INTEGRITY_ONLY: 'Integrity check',
};

function formatDirection(direction: string | null): string {
  if (direction === null) return '—';
  return DIRECTION_LABELS[direction] ?? titleCase(direction);
}

interface FindingDetailProps {
  row: FindingRow;
  onClose: () => void;
  /** Called after a successful status transition so the caller can patch its own row list (86e2v1xyr). */
  onStatusChange?: (id: string, status: string) => void;
}

/**
 * Detail drawer for a single finding (86e2uutk8). Every field it shows is
 * already present on the FindingRow the table holds -- no per-finding fetch.
 * Reuses format.ts/status-display.ts rather than re-deriving money formatting
 * or status labels/colors.
 */
export function FindingDetail({ row, onClose, onStatusChange }: FindingDetailProps) {
  const [status, setStatus] = useState(row.status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [scorecard, setScorecard] = useState<InvoiceScorecard | null>(null);
  const [scorecardError, setScorecardError] = useState(false);
  const [provenance, setProvenance] = useState<FindingProvenance | null>(null);
  const [provenanceError, setProvenanceError] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The drawer is keyed by row.id in the parent (new instance per finding),
  // but reacting to row.status changing on the SAME instance (e.g. a parent
  // re-fetch after this component's own transition) keeps the displayed
  // value in sync rather than frozen at mount time.
  useEffect(() => {
    setStatus(row.status);
  }, [row.status]);

  async function handleStatusSelect(next: string) {
    if (next === status) return;
    const previous = status;
    setStatus(next);
    setPending(true);
    setError(false);
    try {
      await updateFindingStatus(row.id, next);
      onStatusChange?.(row.id, next);
    } catch {
      setStatus(previous);
      setError(true);
    } finally {
      setPending(false);
    }
  }

  function loadProvenance(): void {
    setProvenanceError(false);
    void fetchFindingProvenance(row.id).then(setProvenance, () => setProvenanceError(true));
  }

  const display = getStatusDisplay({ ...row, status });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(32,30,29,0.4)]" onClick={onClose}>
      <div
        data-testid="finding-detail"
        role="dialog"
        aria-label="Finding detail"
        className="flex h-full w-[420px] flex-none flex-col overflow-auto bg-[#f3f2f2] text-[#201e1d] shadow-[0_0_24px_rgba(32,30,29,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
          <span className="text-lg font-extrabold tracking-[-0.015em]">Finding detail</span>
          <button
            type="button"
            aria-label="Close finding detail"
            onClick={onClose}
            className="h-7 w-7 border border-[rgba(32,30,29,0.4)] text-sm font-extrabold"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex justify-end">
            <span
              className="px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-[0.04em]"
              style={{ background: display.tagBg, color: display.tagFg }}
            >
              {display.label}
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <Field label="Invoice">
              <span>{row.invoiceNumber ?? '—'}</span>
              {row.auditRunId && (
                <button type="button" className="ml-2 text-xs font-extrabold underline" onClick={() => {
                  setScorecardError(false);
                  void fetchInvoiceScorecard(row.auditRunId!).then(setScorecard, () => setScorecardError(true));
                }}>View scorecard</button>
              )}
            </Field>
            {scorecard && (
              <div data-testid="invoice-scorecard" className="grid grid-cols-3 gap-2 border border-[rgba(32,30,29,0.3)] p-3 text-center text-xs">
                <div><strong>{scorecard.conformed_count ?? 0}</strong><br />Conformed</div>
                <div><strong>{scorecard.variance_count ?? 0}</strong><br />Variances</div>
                <div><strong>{scorecard.unassessable_count ?? 0}</strong><br />Needs data</div>
                <div className="col-span-3">Overcharge {formatMoney(scorecard.total_overcharge)} · Undercharge {formatMoney(scorecard.total_undercharge)}</div>
              </div>
            )}
            {scorecardError && <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load invoice scorecard.</span>}
            <Field label="Carrier">{row.carrierName ?? '—'}</Field>
            <Field label="Finding">{row.ruleDescription ?? '—'}</Field>
            <Field label="Billed">{formatMoney(row.billed)}</Field>
            <Field label="Expected">{formatMoney(row.expected)}</Field>
            <Field label="Variance">{formatVariance(row.varianceAmount)}</Field>
            <Field label="Direction">{formatDirection(row.direction)}</Field>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="h-8 border border-[rgba(32,30,29,0.4)] text-xs font-extrabold" onClick={loadProvenance}>Explain evaluation</button>
              <button type="button" className="h-8 border border-[rgba(32,30,29,0.4)] text-xs font-extrabold" onClick={loadProvenance}>View source citation</button>
            </div>
            {provenance && (
              <div data-testid="evaluated-ast" className="border border-[rgba(32,30,29,0.3)] p-3">
                <div className="mb-2 text-xs font-extrabold">{provenance.criterion.key}</div>
                <pre className="overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(provenance.finding.evaluatedExpr, null, 2)}</pre>
              </div>
            )}
            {provenance?.clause && (
              <div data-testid="source-citation" className="border border-[rgba(32,30,29,0.3)] p-3 text-xs">
                <div className="font-extrabold">Clause {provenance.clause.reference}{provenance.clause.page ? ` · page ${provenance.clause.page}` : ''}</div>
                {provenance.rateCell && <div className="mt-1">Rate cell {provenance.rateCell.reference}</div>}
                {provenance.sourceDocument && (
                  <div className="mt-2 break-all text-[11px]">
                    SHA-256: {provenance.sourceDocument.sha256}
                    {/^https?:/.test(provenance.sourceDocument.storageUri) ? (
                      <a className="ml-2 font-extrabold underline" target="_blank" rel="noreferrer"
                        href={`${provenance.sourceDocument.storageUri}${provenance.clause.page ? `#page=${provenance.clause.page}` : ''}`}>Open source page</a>
                    ) : <div>Stored securely; direct preview unavailable.</div>}
                  </div>
                )}
              </div>
            )}
            {provenanceError && <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load evaluation explanation.</span>}
            <div className="flex flex-col gap-0.5">
              <label htmlFor="finding-status-select" className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
                Status
              </label>
              <select
                id="finding-status-select"
                aria-label="Finding status"
                value={status}
                disabled={pending}
                onChange={(e) => void handleStatusSelect(e.target.value)}
                className="h-8 border border-[rgba(32,30,29,0.4)] bg-transparent px-2 text-sm font-semibold text-[#201e1d] outline-none disabled:opacity-60"
              >
                {/* A finding seeded at one of the 4 non-filterable enum values
                    (accepted/waived/recovered/written_off -- out of this
                    item's scope per its rabbit holes) still needs its
                    CURRENT value representable, or the browser would
                    silently coerce the select to WRITABLE_STATUSES[0] and a
                    no-op onChange would misreport that as a chosen
                    transition. Rendered read-only-in-effect: selecting it
                    back is a no-op in handleStatusSelect (next === status). */}
                {!WRITABLE_STATUSES.includes(status as (typeof WRITABLE_STATUSES)[number]) && (
                  <option value={status}>{titleCase(status)}</option>
                )}
                {WRITABLE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>
              {error && (
                <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t update status. Try again.</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
        {label}
      </span>
      <span className="text-sm font-semibold text-[#201e1d]">{children}</span>
    </div>
  );
}
