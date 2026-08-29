import { useEffect, useState, type ReactNode } from 'react';
import { fetchClaimDetail, type ClaimDetail as ClaimDetailData } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { titleCase } from '../lib/status-display.js';

interface ClaimDetailProps {
  claimId: string;
  onClose: () => void;
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Detail drawer for a single claim, including its full recovery-event
 * history (P5.B.5). Mirrors FindingDetail.tsx's structure: a props-driven
 * drawer over a single detail+history fetch, following #181's (open,
 * unmerged) GET /api/claims/:id contract exactly -- that endpoint already
 * returns the claim plus recoveryEvents[] and cumulativeRecovered in one
 * response, so there is no separate history fetch here.
 */
export function ClaimDetail({ claimId, onClose }: ClaimDetailProps) {
  const [claim, setClaim] = useState<ClaimDetailData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setClaim(null);
    setError(false);
    let cancelled = false;
    fetchClaimDetail(claimId).then(
      (data) => { if (!cancelled) setClaim(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [claimId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(32,30,29,0.4)]" onClick={onClose}>
      <div
        data-testid="claim-detail"
        role="dialog"
        aria-label="Claim detail"
        className="flex h-full w-[420px] flex-none flex-col overflow-auto bg-[#f3f2f2] text-[#201e1d] shadow-[0_0_24px_rgba(32,30,29,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
          <span className="text-lg font-extrabold tracking-[-0.015em]">Claim detail</span>
          <button
            type="button"
            aria-label="Close claim detail"
            onClick={onClose}
            className="h-7 w-7 border border-[rgba(32,30,29,0.4)] text-sm font-extrabold"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="px-5 py-4">
            <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load claim.</span>
          </div>
        )}

        {!error && claim === null && (
          <div className="px-5 py-4">
            <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
          </div>
        )}

        {claim && (
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="flex flex-col gap-3">
              <Field label="Status">{titleCase(claim.status)}</Field>
              <Field label="Amount claimed">{formatMoney(claim.amountClaimed)}</Field>
              <Field label="Cumulative recovered">{formatMoney(claim.cumulativeRecovered)}</Field>
              <Field label="Opened">{formatDate(claim.openedAt)}</Field>
              <Field label="Aging deadline">{formatDate(claim.agingDeadlineAt)}</Field>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
                Recovery history
              </span>
              {claim.recoveryEvents.length === 0 ? (
                <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">No recovery events yet.</span>
              ) : (
                <ul data-testid="recovery-event-list" className="flex flex-col gap-2">
                  {claim.recoveryEvents.map((event) => (
                    <li
                      key={event.id}
                      data-testid="recovery-event"
                      className="flex items-center justify-between border border-[rgba(32,30,29,0.3)] p-2 text-xs"
                    >
                      <span>{formatDate(event.recordedAt)}</span>
                      <span className="font-extrabold">{formatMoney(event.amountRecovered)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
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
