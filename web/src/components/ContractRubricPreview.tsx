import { useState } from 'react';
import { acceptContractRuleProposal, ratifyContractRuleProposal, type ContractRuleProposalPreview } from '../lib/api.js';

function shortHash(value: string) { return value.slice(0, 12); }
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }

export function ContractRubricPreview({ rows, onAccepted, onRatified }: { rows: ContractRuleProposalPreview[]; onAccepted?: (id: string, shadowId: string, rationale: string) => void; onRatified?:(id:string,activeId:string,rationale:string)=>void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  return <section data-testid="contract-rubric-preview" className="flex-none border border-[rgba(32,30,29,.3)] bg-[#f3f2f2]">
    <div className="border-b border-[rgba(32,30,29,.2)] p-4">
      <h2 className="text-base font-extrabold">Contract rubric preview</h2>
      <p className="mt-1 text-xs text-[rgba(32,30,29,.62)]">Read-only proposal diff with clause, model, verification, and backtest evidence. Previewing cannot activate a rule.</p>
    </div>
    {!rows.length && <div className="p-4 text-sm text-[rgba(32,30,29,.65)]">No contract rule proposals are ready to preview.</div>}
    {rows.map((row) => <article key={row.id} data-testid="contract-proposal-preview" className="border-t border-[rgba(32,30,29,.18)] p-4 first:border-t-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><div className="text-[11px] font-bold uppercase tracking-wide text-[rgba(32,30,29,.55)]">{row.contractName}</div>
          <h3 className="mt-1 font-mono text-sm font-extrabold">{row.criterionKey}</h3><p className="mt-1 text-sm">{row.description}</p></div>
        <span className={`px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide ${row.diff.status === 'CHANGED' ? 'bg-[#fff0cc] text-[#7a4b00]' : row.diff.status === 'NEW' ? 'bg-[#dcecf7] text-[#175275]' : 'bg-[#dceddf] text-[#27603d]'}`}>{row.diff.status}</span>
        <span className={`px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide ${row.backtest?.passed ? 'bg-[#dceddf] text-[#27603d]' : 'bg-[#f6d9d5] text-[#8a2418]'}`}>{row.backtest ? row.backtest.passed ? `Backtest passed ${row.backtest.passCount}/${row.backtest.passCount + row.backtest.regressionCount}` : `${row.backtest.regressionCount} regressions` : 'Backtest missing'}</span>
        {row.acceptance && <span className="bg-[#d8d3ef] px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[#463b78]">Accepted to SHADOW</span>}
        {row.ratification && <span className="bg-[#201e1d] px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-white">Human-ratified ACTIVE / FIRM</span>}
      </div>
      <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3"><div><dt className="font-extrabold uppercase">Rule type</dt><dd>{row.ruleType}</dd></div>
        <div><dt className="font-extrabold uppercase">AST hash</dt><dd className="font-mono" title={row.astHash}>{shortHash(row.astHash)}…</dd></div>
        <div><dt className="font-extrabold uppercase">Model / prompt</dt><dd>{row.modelId} · {row.promptVersion}</dd></div></dl>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">{row.clauses.map((clause) => <span key={clause.clauseId} className="border border-[rgba(32,30,29,.25)] bg-white px-2 py-1">Clause {clause.clauseRef}{clause.pageRef ? ` · p. ${clause.pageRef}` : ''}</span>)}</div>
      <button type="button" aria-expanded={open === row.id} className="mt-3 border border-[rgba(32,30,29,.4)] px-3 py-1.5 text-xs font-extrabold" onClick={() => setOpen(open === row.id ? null : row.id)}>{open === row.id ? 'Hide diff' : 'Inspect diff'}</button>
      {!row.acceptance && row.backtest?.passed && <div className="mt-3 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={`accept-rationale-${row.id}`}>Acceptance rationale for {row.criterionKey}</label>
        <input id={`accept-rationale-${row.id}`} value={accepting === row.id ? rationale : ''}
          onFocus={() => { if (accepting !== row.id) setRationale(''); setAccepting(row.id); setError(null); }}
          onChange={(event) => setRationale(event.target.value)} placeholder="Analyst acceptance rationale"
          className="h-9 min-w-[240px] flex-1 border border-[rgba(32,30,29,.35)] bg-white px-3 text-xs" />
        <button type="button" disabled={accepting !== row.id || !rationale.trim()}
          className="h-9 bg-[#201e1d] px-4 text-xs font-extrabold text-white disabled:opacity-35"
          onClick={() => { setError(null); const reason = rationale.trim(); void acceptContractRuleProposal(row.id, row.backtest!.id, reason)
            .then((result) => onAccepted?.(row.id, result.shadowRuleVersionId, reason), () => setError(row.id)); }}>Accept to SHADOW</button>
      </div>}
      {error === row.id && <p role="alert" className="mt-2 text-xs font-bold text-[#b3261e]">Proposal could not be accepted. Refresh its backtest evidence and try again.</p>}
      {row.acceptance&&!row.ratification&&<div className="mt-3 flex flex-wrap gap-2"><label className="sr-only" htmlFor={`ratify-rationale-${row.id}`}>Ratification rationale for {row.criterionKey}</label><input id={`ratify-rationale-${row.id}`} value={accepting===`ratify-${row.id}`?rationale:''} onFocus={()=>{setAccepting(`ratify-${row.id}`);setRationale('');setError(null);}} onChange={event=>setRationale(event.target.value)} placeholder="Human ACTIVE / FIRM rationale" className="h-9 min-w-[240px] flex-1 border bg-white px-3 text-xs"/><button type="button" disabled={accepting!==`ratify-${row.id}`||!rationale.trim()} className="h-9 bg-[#ec3013] px-4 text-xs font-extrabold text-white disabled:opacity-35" onClick={()=>{const reason=rationale.trim();void ratifyContractRuleProposal(row.acceptance!.id,reason).then(result=>onRatified?.(row.id,result.activeRuleVersionId,reason),()=>setError(`ratify-${row.id}`));}}>Ratify ACTIVE / FIRM</button></div>}
      {error===`ratify-${row.id}`&&<p role="alert" className="mt-2 text-xs font-bold text-[#b3261e]">Ratification failed closed. Refresh the acceptance evidence and try again.</p>}
      {open === row.id && <div className="mt-3 grid gap-3 lg:grid-cols-2" data-testid="proposal-diff">
        <div><h4 className="mb-1 text-xs font-extrabold">Current active criterion</h4><pre className="max-h-72 overflow-auto bg-[#201e1d] p-3 text-[11px] text-white">{row.baseline ? pretty(row.baseline.ast) : 'No active criterion with this key.'}</pre></div>
        <div><h4 className="mb-1 text-xs font-extrabold">Proposed criterion</h4><pre className="max-h-72 overflow-auto bg-[#201e1d] p-3 text-[11px] text-white">{pretty(row.ast)}</pre></div>
        <div className="lg:col-span-2 text-[11px] text-[rgba(32,30,29,.68)]">Expected inputs: {row.expectedInputs.join(', ') || 'none'} · Source {shortHash(row.sourceDocumentSha256)}… · Extraction {shortHash(row.extractionResponseHash)}… · Verification {shortHash(row.verificationHash)}…</div>
      </div>}
    </article>)}
  </section>;
}
