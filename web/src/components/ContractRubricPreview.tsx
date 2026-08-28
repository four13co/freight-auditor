import { useState } from 'react';
import type { ContractRuleProposalPreview } from '../lib/api.js';

function shortHash(value: string) { return value.slice(0, 12); }
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }

export function ContractRubricPreview({ rows }: { rows: ContractRuleProposalPreview[] }) {
  const [open, setOpen] = useState<string | null>(null);
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
      </div>
      <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3"><div><dt className="font-extrabold uppercase">Rule type</dt><dd>{row.ruleType}</dd></div>
        <div><dt className="font-extrabold uppercase">AST hash</dt><dd className="font-mono" title={row.astHash}>{shortHash(row.astHash)}…</dd></div>
        <div><dt className="font-extrabold uppercase">Model / prompt</dt><dd>{row.modelId} · {row.promptVersion}</dd></div></dl>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">{row.clauses.map((clause) => <span key={clause.clauseId} className="border border-[rgba(32,30,29,.25)] bg-white px-2 py-1">Clause {clause.clauseRef}{clause.pageRef ? ` · p. ${clause.pageRef}` : ''}</span>)}</div>
      <button type="button" aria-expanded={open === row.id} className="mt-3 border border-[rgba(32,30,29,.4)] px-3 py-1.5 text-xs font-extrabold" onClick={() => setOpen(open === row.id ? null : row.id)}>{open === row.id ? 'Hide diff' : 'Inspect diff'}</button>
      {open === row.id && <div className="mt-3 grid gap-3 lg:grid-cols-2" data-testid="proposal-diff">
        <div><h4 className="mb-1 text-xs font-extrabold">Current active criterion</h4><pre className="max-h-72 overflow-auto bg-[#201e1d] p-3 text-[11px] text-white">{row.baseline ? pretty(row.baseline.ast) : 'No active criterion with this key.'}</pre></div>
        <div><h4 className="mb-1 text-xs font-extrabold">Proposed criterion</h4><pre className="max-h-72 overflow-auto bg-[#201e1d] p-3 text-[11px] text-white">{pretty(row.ast)}</pre></div>
        <div className="lg:col-span-2 text-[11px] text-[rgba(32,30,29,.68)]">Expected inputs: {row.expectedInputs.join(', ') || 'none'} · Source {shortHash(row.sourceDocumentSha256)}… · Extraction {shortHash(row.extractionResponseHash)}… · Verification {shortHash(row.verificationHash)}…</div>
      </div>}
    </article>)}
  </section>;
}
