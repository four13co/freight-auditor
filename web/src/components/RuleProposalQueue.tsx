import { useState } from 'react';
import { activateShadowRule, ratifyRuleProposal, type RuleProposal } from '../lib/api.js';

export function RuleProposalQueue({ rows, onRatified }: { rows: RuleProposal[]; onRatified: (oldId: string, newId: string, lifecycle: 'SHADOW' | 'ACTIVE') => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!rows.length) return null;
  return <section data-testid="rule-proposal-queue" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
    <h2 className="mb-2 text-sm font-extrabold">Rule proposals ({rows.length})</h2>
    {/* One <div> per row -- existing e2e specs locate a row via queue.locator('div').filter({ hasText: slug }) and require exactly one match, so anything added to a row must stay a sibling here, never a nested <div>. */}
    {rows.map((row) => <div key={row.id} className="flex flex-wrap items-center gap-3 border-t py-2 text-xs">
      <span className="font-extrabold">{row.slug}</span><span>{row.rule_type}</span><span>{row.hardness}</span><span>{row.lifecycle_state}</span>
      {row.lifecycle_state === 'PROPOSED' && <button disabled={pending === row.id} className="ml-auto border px-2 py-1 font-extrabold" onClick={() => {
        const oldId = row.id;
        setPending(oldId); void ratifyRuleProposal(oldId, 'Analyst ratification').then(({ ruleVersionId }) => onRatified(oldId, ruleVersionId, 'SHADOW')).finally(() => setPending(null));
      }}>Ratify to shadow</button>}
      {row.lifecycle_state === 'SHADOW' && <span className="ml-auto flex w-full flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`activate-rationale-${row.id}`}>Activation rationale for {row.slug}</label>
        <input id={`activate-rationale-${row.id}`} value={activating === row.id ? rationale : ''}
          onFocus={() => { setActivating(row.id); setRationale(''); setError(null); }}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Activation rationale (a different analyst than the one who ratified)"
          className="h-9 min-w-[280px] flex-1 border bg-white px-3 text-xs" />
        <button disabled={activating !== row.id || !rationale.trim() || pending === row.id} className="border px-2 py-1 font-extrabold disabled:opacity-35" onClick={() => {
          const oldId = row.id; const reason = rationale.trim();
          setPending(oldId); setError(null);
          void activateShadowRule(oldId, reason)
            .then(({ ruleVersionId }) => { onRatified(oldId, ruleVersionId, 'ACTIVE'); setRationale(''); }, () => setError(oldId))
            .finally(() => setPending(null));
        }}>Activate</button>
      </span>}
      {error === row.id && <span role="alert" className="block w-full text-xs font-bold text-[#b3261e]">Activation rejected — a different analyst than the one who ratified this rule must activate it.</span>}
    </div>)}
  </section>;
}
