import { useState } from 'react';
import { activateShadowRule, ratifyRuleProposal, type RuleProposal } from '../lib/api.js';

export function RuleProposalQueue({ rows, onRatified }: { rows: RuleProposal[]; onRatified: (oldId: string, newId: string, lifecycle: 'SHADOW' | 'ACTIVE') => void }) {
  const [pending, setPending] = useState<string | null>(null);
  if (!rows.length) return null;
  return <section data-testid="rule-proposal-queue" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
    <h2 className="mb-2 text-sm font-extrabold">Rule proposals ({rows.length})</h2>
    {rows.map((row) => <div key={row.id} className="flex items-center gap-3 border-t py-2 text-xs">
      <span className="font-extrabold">{row.slug}</span><span>{row.rule_type}</span><span>{row.hardness}</span><span>{row.lifecycle_state}</span>
      {row.lifecycle_state === 'PROPOSED' && <button disabled={pending === row.id} className="ml-auto border px-2 py-1 font-extrabold" onClick={() => {
        const oldId = row.id;
        setPending(oldId); void ratifyRuleProposal(oldId, 'Analyst ratification').then(({ ruleVersionId }) => onRatified(oldId, ruleVersionId, 'SHADOW')).finally(() => setPending(null));
      }}>Ratify to shadow</button>}
      {row.lifecycle_state === 'SHADOW' && <button disabled={pending === row.id} className="ml-auto border px-2 py-1 font-extrabold" onClick={() => {
        const oldId = row.id;
        setPending(oldId); void activateShadowRule(oldId, 'Backtest-approved activation').then(({ ruleVersionId }) => onRatified(oldId, ruleVersionId, 'ACTIVE')).finally(() => setPending(null));
      }}>Activate</button>}
    </div>)}
  </section>;
}
