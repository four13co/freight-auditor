import { useEffect, useState, type ReactNode } from 'react';
import { approveDispute as approveDisputeRequest, fetchDisputeDetail, type DisputeDetail } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { titleCase } from '../lib/status-display.js';

interface DisputeReviewProps {
  disputeId: string;
  onClose: () => void;
  /** Called after a successful approval so the caller can patch its own row list. */
  onApproved?: (id: string, status: string) => void;
}

/**
 * Dispute review + approval drawer (P4.C.6): an analyst inspects a draft
 * dispute's lines/amounts and approves it for delivery (draft -> sent).
 * Mirrors ClaimDetail.tsx's structure (props-driven drawer, self-fetching
 * on mount). Deliberately does NOT render #173's evidence prose -- that
 * module is open/unmerged with no persistence or fetch route; lines +
 * amounts + currency is this item's reviewable surface.
 */
export function DisputeReview({ disputeId, onClose, onApproved }: DisputeReviewProps) {
  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [error, setError] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(false);

  useEffect(() => {
    setDispute(null);
    setError(false);
    let cancelled = false;
    fetchDisputeDetail(disputeId).then(
      (data) => { if (!cancelled) setDispute(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [disputeId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function handleApprove(): void {
    setApproving(true);
    setApproveError(false);
    void approveDisputeRequest(disputeId).then(
      (result) => {
        setDispute((prev) => (prev ? { ...prev, status: result.status } : prev));
        onApproved?.(disputeId, result.status);
      },
      () => setApproveError(true),
    ).finally(() => setApproving(false));
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(32,30,29,0.4)]" onClick={onClose}>
      <div
        data-testid="dispute-review"
        role="dialog"
        aria-label="Dispute review"
        className="flex h-full w-[420px] flex-none flex-col overflow-auto bg-[#f3f2f2] text-[#201e1d] shadow-[0_0_24px_rgba(32,30,29,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
          <span className="text-lg font-extrabold tracking-[-0.015em]">Dispute review</span>
          <button
            type="button"
            aria-label="Close dispute review"
            onClick={onClose}
            className="h-7 w-7 border border-[rgba(32,30,29,0.4)] text-sm font-extrabold"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="px-5 py-4">
            <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load dispute.</span>
          </div>
        )}

        {!error && dispute === null && (
          <div className="px-5 py-4">
            <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
          </div>
        )}

        {dispute && (
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="flex flex-col gap-3">
              <Field label="Status">{titleCase(dispute.status)}</Field>
              <Field label="Amount claimed">{formatMoney(dispute.amountClaimed)}</Field>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
                Dispute lines
              </span>
              {dispute.lines.length === 0 ? (
                <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">No lines yet.</span>
              ) : (
                <ul data-testid="dispute-line-list" className="flex flex-col gap-2">
                  {dispute.lines.map((line) => (
                    <li key={line.id} data-testid="dispute-line" className="border border-[rgba(32,30,29,0.3)] p-2 text-xs">
                      {formatMoney(line.amount)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              disabled={approving || dispute.status !== 'draft'}
              onClick={handleApprove}
              className="h-8 border border-[#287a3d] text-xs font-extrabold disabled:opacity-60"
            >
              {dispute.status === 'draft' ? 'Approve for delivery' : 'Approved'}
            </button>
            {approveError && (
              <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t approve dispute. Try again.</span>
            )}
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
