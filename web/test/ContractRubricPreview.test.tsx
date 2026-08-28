import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  diff: { status: 'CHANGED', astChanged: true, descriptionChanged: true },
};

describe('ContractRubricPreview', () => {
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
});
