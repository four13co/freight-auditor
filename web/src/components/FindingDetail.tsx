import { useEffect, type ReactNode } from 'react';
import type { FindingRow } from '../lib/api.js';
import { formatMoney, formatVariance } from '../lib/format.js';
import { getStatusDisplay, titleCase } from '../lib/status-display.js';

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
}

/**
 * Detail drawer for a single finding (86e2uutk8). Every field it shows is
 * already present on the FindingRow the table holds -- no per-finding fetch.
 * Reuses format.ts/status-display.ts rather than re-deriving money formatting
 * or status labels/colors.
 */
export function FindingDetail({ row, onClose }: FindingDetailProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const display = getStatusDisplay(row);

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
            <Field label="Invoice">{row.invoiceNumber ?? '—'}</Field>
            <Field label="Carrier">{row.carrierName ?? '—'}</Field>
            <Field label="Finding">{row.ruleDescription ?? '—'}</Field>
            <Field label="Billed">{formatMoney(row.billed)}</Field>
            <Field label="Expected">{formatMoney(row.expected)}</Field>
            <Field label="Variance">{formatVariance(row.varianceAmount)}</Field>
            <Field label="Direction">{formatDirection(row.direction)}</Field>
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
