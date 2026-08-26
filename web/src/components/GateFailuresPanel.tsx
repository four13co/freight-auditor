import { useState } from 'react';
import type { GateFailureRow } from '../lib/api.js';
import { formatAge } from '../lib/format.js';

interface GateFailuresPanelProps {
  rows: GateFailureRow[];
}

/**
 * 86e2v17xn: rejected invoices, surfaced separately from FindingsTable.
 *
 * Deliberately does NOT reuse getStatusDisplay's Overcharge/Undercharge/
 * Queued tag vocabulary (the item's explicit AC) -- a gate failure isn't a
 * per-charge variance with a direction or a workflow status; it's a
 * structural kickback ("this invoice was never scored"). The red-bordered
 * "Rejected" pill here is its own, single, unconditional label rather than
 * anything derived from variance_status/variance_direction, so there's no
 * shared vocabulary to accidentally collide with FindingsTable's.
 *
 * Renders nothing when empty -- Dashboard only mounts this panel when there
 * ARE rejected invoices to show (see Dashboard.tsx), so an empty-state
 * message here would never actually be reachable; guarded defensively
 * anyway in case a future caller renders it unconditionally.
 */
export function GateFailuresPanel({ rows }: GateFailuresPanelProps) {
  const [reviewing, setReviewing] = useState<string | null>(null);
  if (rows.length === 0) return null;

  return (
    <div
      data-testid="gate-failures-panel"
      className="flex flex-col overflow-hidden border-2 border-[#ec3013] bg-[#f3f2f2] shadow-[0_1px_2px_rgba(45,43,43,0.14)]"
    >
      <div className="flex items-center gap-3 border-b-2 border-[#ec3013] bg-[#ffe0d9] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#7c1405]">Rejected invoices</span>
        <span className="text-xs font-semibold text-[#7c1405]">
          Kicked back before scoring -- not a variance, a structural defect.
        </span>
      </div>

      <div className="flex-1 overflow-auto" data-testid="gate-failure-rows" aria-label="Rejected invoices">
        {rows.map((row) => (
          <div
            key={row.id}
            data-testid="gate-failure-row"
            className="flex cursor-pointer flex-col gap-2 border-b border-[rgba(32,30,29,0.14)] px-5 py-3"
            role="button" tabIndex={0} aria-label={`Review kickback ${row.invoiceNumber ?? row.id}`}
            onClick={() => setReviewing((current) => current === row.id ? null : row.id)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setReviewing((current) => current === row.id ? null : row.id); }}
          >
            <div className="flex items-center gap-3">
              <span className="border border-[#7c1405] bg-[#ec3013] px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-[0.04em] text-[#f3f2f2]">
                Rejected
              </span>
              <span className="text-[13px] font-semibold tabular-nums text-[#201e1d]">
                {row.invoiceNumber ?? '—'}
              </span>
              <span className="text-[13px] text-[#201e1d]">{row.carrierName ?? '—'}</span>
              <span className="ml-auto text-xs tabular-nums text-[rgba(32,30,29,0.6)]">
                {formatAge(row.recordedAt)}
              </span>
            </div>
            <div className="text-sm font-semibold text-[#201e1d]">{row.defect}</div>
            {row.citation && <div className="text-xs text-[rgba(32,30,29,0.65)]">{row.citation}</div>}
            {reviewing === row.id && (
              <div data-testid="gate-kickback-review" className="border border-[#7c1405] bg-[#fff4f1] p-3 text-xs">
                <div className="font-extrabold">{row.criterionKey ?? 'Structural gate'}</div>
                {row.clauseReference && <div>Clause {row.clauseReference}</div>}
                <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(row.evaluatedExpr ?? {}, null, 2)}</pre>
                <div className="mt-2 text-[11px]">Source evidence: {row.sourceDocumentId ?? 'not linked'} · Transport evidence: {row.transportDocumentId ?? 'not linked'}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
