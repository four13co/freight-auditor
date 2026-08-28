import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractRubricPreview } from '../src/components/ContractRubricPreview.js';
import type { ContractRuleProposalPreview } from '../src/lib/api.js';

const row: ContractRuleProposalPreview = {
  id: 'p1', verifiedContractVersionId: 'v1', contractName: 'Acme 2026', criterionKey: 'CONTRACT.PROPOSED.FUEL_PRESENT',
  ruleType: 'CONTRACT_CONFORMANCE', description: 'Fuel is present.', ast: { type: 'compare', op: 'eq',
    left: { type: 'fact', key: 'has_fuel_category' }, right: { type: 'lit', value: true } }, astHash: 'a'.repeat(64),
  expectedInputs: ['has_fuel_category'], lifecycleState: 'PROPOSED', modelId: 'claude-opus-5',
  promptVersion: 'contract-proposed-criteria/1', sourceDocumentSha256: 'b'.repeat(64), extractionResponseHash: 'c'.repeat(64),
  verificationHash: 'd'.repeat(64), recordedAt: '2026-08-27T00:00:00.000Z',
  clauses: [{ clauseId: 'cl1', clauseRef: '4.2', textExcerpt: 'Fuel applies.', pageRef: '7', citations: [{ pageNumber: 7 }] }],
  backtest: { id: 'bt1', passed: true, passCount: 3, regressionCount: 0, corpusHash: 'e'.repeat(64), recordedAt: '2026-08-27T00:01:00.000Z' },
  baseline: { ast: { type: 'lit', value: false }, astHash: 'f'.repeat(64), description: 'Old fuel rule.' },
  acceptance: null,
  ratification: null,
  diff: { status: 'CHANGED', astChanged: true, descriptionChanged: true },
};

describe('ContractRubricPreview', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows immutable provenance, clause location, diff status, and passing backtest without activation controls', () => {
    render(<ContractRubricPreview rows={[row]} />);
    const card = screen.getByTestId('contract-proposal-preview');
    expect(within(card).getByText('Acme 2026')).toBeInTheDocument();
    expect(within(card).getByText('CHANGED')).toBeInTheDocument();
    expect(within(card).getByText('Backtest passed 3/3')).toBeInTheDocument();
    expect(within(card).getByText('Clause 4.2 · p. 7')).toBeInTheDocument();
    expect(within(card).getByText('claude-opus-5 · contract-proposed-criteria/1')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /activate|ratify/i })).not.toBeInTheDocument();
  });

  it('expands a side-by-side active/proposed AST diff and exposes all evidence pins', () => {
    render(<ContractRubricPreview rows={[row]} />); fireEvent.click(screen.getByRole('button', { name: 'Inspect diff' }));
    const diff = screen.getByTestId('proposal-diff');
    expect(within(diff).getByText('Current active criterion')).toBeInTheDocument();
    expect(within(diff).getByText('Proposed criterion')).toBeInTheDocument();
    expect(diff).toHaveTextContent('has_fuel_category');
    expect(diff).toHaveTextContent(/Expected inputs: has_fuel_category · Source b{12}/);
    fireEvent.click(screen.getByRole('button', { name: 'Hide diff' })); expect(screen.queryByTestId('proposal-diff')).not.toBeInTheDocument();
  });

  it('distinguishes no baseline, missing backtest, and an empty tenant', () => {
    const proposal = { ...row, baseline: null, backtest: null, diff: { status: 'NEW' as const, astChanged: false, descriptionChanged: false } };
    const { rerender } = render(<ContractRubricPreview rows={[proposal]} />);
    expect(screen.getByText('NEW')).toBeInTheDocument(); expect(screen.getByText('Backtest missing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect diff' })); expect(screen.getByText('No active criterion with this key.')).toBeInTheDocument();
    rerender(<ContractRubricPreview rows={[]} />); expect(screen.getByText('No contract rule proposals are ready to preview.')).toBeInTheDocument();
  });

  it('requires analyst rationale and posts only a passing pinned backtest to SHADOW', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shadowRuleVersionId: 'shadow-1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetch); const accepted = vi.fn(); render(<ContractRubricPreview rows={[row]} onAccepted={accepted} />);
    const button = screen.getByRole('button', { name: 'Accept to SHADOW' }); expect(button).toBeDisabled();
    fireEvent.focus(screen.getByLabelText(`Acceptance rationale for ${row.criterionKey}`));
    fireEvent.change(screen.getByLabelText(`Acceptance rationale for ${row.criterionKey}`), { target: { value: '  Reviewed evidence  ' } });
    fireEvent.click(button); await waitFor(() => expect(accepted).toHaveBeenCalledWith('p1', 'shadow-1', 'Reviewed evidence'));
    expect(fetch).toHaveBeenCalledWith('/api/contracts/rule-proposals/p1/accept', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ backtestId: 'bt1', rationale: 'Reviewed evidence' });
  });

  it('requires a second explicit human rationale before ACTIVE / FIRM ratification',async()=>{const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({activeRuleVersionId:'active-1'}),{status:201}));vi.stubGlobal('fetch',fetch);const ratified=vi.fn();const accepted={...row,acceptance:{id:'accept-1',shadowRuleVersionId:'shadow-1',acceptedBy:'human',rationale:'accept',recordedAt:row.recordedAt}};render(<ContractRubricPreview rows={[accepted]} onRatified={ratified}/>);const button=screen.getByRole('button',{name:'Ratify ACTIVE / FIRM'});expect(button).toBeDisabled();fireEvent.focus(screen.getByLabelText(`Ratification rationale for ${row.criterionKey}`));fireEvent.change(screen.getByLabelText(`Ratification rationale for ${row.criterionKey}`),{target:{value:'Human reviewed shadow outcomes'}});fireEvent.click(button);await waitFor(()=>expect(ratified).toHaveBeenCalledWith('p1','active-1','Human reviewed shadow outcomes'));expect(fetch).toHaveBeenCalledWith('/api/contracts/rule-proposal-acceptances/accept-1/ratify',expect.objectContaining({method:'POST'}));});
});
