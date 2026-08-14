import type { FindingsSummary } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';

interface KpiRowProps {
  summary: FindingsSummary;
}

/** The four KPI cards from the 1B Console mockup: one accent card + three light cards. */
export function KpiRow({ summary }: KpiRowProps) {
  return (
    <div className="grid grid-cols-4 gap-4" data-testid="kpi-row">
      <div className="flex flex-col gap-1.5 bg-[#ec3013] p-5 text-[#f3f2f2] shadow-[0_3px_10px_rgba(45,43,43,0.16)]">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] opacity-85">Recoverable, open</div>
        <div className="text-[34px] font-extrabold leading-none tracking-[-0.02em] tabular-nums">
          {formatMoney(summary.recoverableOpen)}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 bg-[#f8f4f4] p-5 shadow-[0_1px_2px_rgba(45,43,43,0.14)]">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(32,30,29,0.55)]">
          Flagged today
        </div>
        <div className="text-[34px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-[#201e1d]">
          {summary.flaggedToday}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 bg-[#f8f4f4] p-5 shadow-[0_1px_2px_rgba(45,43,43,0.14)]">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(32,30,29,0.55)]">
          With carriers
        </div>
        <div className="text-[34px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-[#201e1d]">
          {summary.withCarriers}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 bg-[#f8f4f4] p-5 shadow-[0_1px_2px_rgba(45,43,43,0.14)]">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(32,30,29,0.55)]">
          Recovered, 30 days
        </div>
        <div className="text-[34px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-[#201e1d]">
          {formatMoney(summary.recoveredLast30Days)}
        </div>
      </div>
    </div>
  );
}
