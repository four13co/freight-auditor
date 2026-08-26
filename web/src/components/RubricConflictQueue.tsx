import type { RubricConflict } from '../lib/api.js';

export function RubricConflictQueue({ rows }: { rows: RubricConflict[] }) {
  if (!rows.length) return null;
  return <section data-testid="rubric-conflict-queue" className="border-2 border-[#d18b00] bg-[#fff8e8] p-3">
    <h2 className="mb-2 text-sm font-extrabold">Rubric resolution conflicts ({rows.length})</h2>
    {rows.map((row) => <div key={row.id} className="grid grid-cols-3 border-t py-1 text-xs">
      <span>{row.criterion_key ?? 'Global'}</span><span>{row.conflict_type}</span>
      <span>{String(row.detail.reason ?? row.detail.reasonCode ?? 'Review required')}</span>
    </div>)}
  </section>;
}
