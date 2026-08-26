import type { ReviewQueues as ReviewQueuesData } from '../lib/api.js';

export function ReviewQueues({ queues }: { queues: ReviewQueuesData }) {
  if (queues.escalation.length === 0 && queues.unassessable.length === 0) return null;
  return <div data-testid="review-queues" className="grid grid-cols-2 gap-4">
    {([['Escalations', queues.escalation], ['Needs evidence', queues.unassessable]] as const).map(([title, rows]) =>
      <section key={title} className="border border-[rgba(32,30,29,0.3)] bg-[#f3f2f2] p-3">
        <h2 className="mb-2 text-sm font-extrabold">{title} <span className="text-[rgba(32,30,29,0.55)]">({rows.length})</span></h2>
        {rows.slice(0, 5).map((row) => <div key={row.id} className="flex justify-between border-t py-1 text-xs">
          <span>{row.invoiceNumber ?? '—'}</span><span>{row.criterionKey}</span>
        </div>)}
      </section>)}
  </div>;
}
