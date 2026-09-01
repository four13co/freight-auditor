import { useState } from 'react';
import { submitPaymentAuthorization, type PendingPaymentAuthorizationRow } from '../lib/api.js';
import { formatAge } from '../lib/format.js';

interface PaymentApprovalQueueProps {
  rows: PendingPaymentAuthorizationRow[];
  onDecided: (auditRunId: string) => void;
}

/**
 * P4.B.6: the analyst-facing side of the hold-then-approve default
 * (P4.B.2/P4.B.5) -- every row here is an audit run the platform parked on
 * 'hold' pending a real human decision (Master Spec §10's "no automatic
 * payment approval"). Only offers Approve, deliberately: this UI's boundary
 * is analyst authorization (approve/hold), not short-pay or do-not-pay,
 * which are separate decision paths (P4.B.3/P4.B.4) with their own review
 * surfaces, not buttons on this queue.
 */
export function PaymentApprovalQueue({ rows, onDecided }: PaymentApprovalQueueProps) {
  const [pending, setPending] = useState<string | null>(null);
  if (!rows.length) return null;

  return (
    <section data-testid="payment-approval-queue" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Payment approvals ({rows.length})</h2>
      {rows.map((row) => (
        <div key={row.auditRunId} className="flex items-center gap-3 border-t py-2 text-xs">
          <span className="font-extrabold">{row.invoiceNumber ?? '—'}</span>
          <span>{row.carrierName ?? '—'}</span>
          <span className="tabular-nums text-[rgba(32,30,29,0.6)]">{formatAge(row.heldAt)}</span>
          <button
            disabled={pending === row.auditRunId}
            className="ml-auto border px-2 py-1 font-extrabold"
            onClick={() => {
              setPending(row.auditRunId);
              void submitPaymentAuthorization(row.auditRunId, 'approve')
                .then(() => onDecided(row.auditRunId))
                .finally(() => setPending(null));
            }}
          >
            Approve
          </button>
        </div>
      ))}
    </section>
  );
}
