import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GateFailuresPanel } from '../src/components/GateFailuresPanel.js';
import { GATE_FAILURE_ROWS } from './fixtures.js';

describe('GateFailuresPanel (86e2v17xn)', () => {
  it('AC4: renders a distinct visual treatment, not the Overcharge/Undercharge/Queued tag vocabulary', () => {
    render(<GateFailuresPanel rows={GATE_FAILURE_ROWS} />);
    const panel = screen.getByTestId('gate-failures-panel');
    expect(within(panel).queryByText('Overcharge')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Undercharge')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Queued')).not.toBeInTheDocument();
    // Its own, single, unconditional label -- one per row (3 rows fixture).
    expect(within(panel).getAllByText('Rejected')).toHaveLength(3);
  });

  it('AC2: surfaces ALL gate_failure rows for one rejected invoice, not just the first (COLLECT_ALL)', () => {
    render(<GateFailuresPanel rows={GATE_FAILURE_ROWS} />);
    const rows = screen.getAllByTestId('gate-failure-row');
    const forInvoice1 = rows.filter((r) => within(r).queryByText('INV-REJECT-1'));
    expect(forInvoice1).toHaveLength(2);
    expect(within(forInvoice1[0]!).getByText(/foots/)).toBeInTheDocument();
    expect(within(forInvoice1[1]!).getByText(/parseable/)).toBeInTheDocument();
  });

  it('renders carrierName: null as an em dash, not "null" or blank', () => {
    render(<GateFailuresPanel rows={GATE_FAILURE_ROWS} />);
    const row = screen.getAllByTestId('gate-failure-row')[2]!; // gf3, carrierName: null
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('renders citation: null without crashing or showing "null"', () => {
    render(<GateFailuresPanel rows={GATE_FAILURE_ROWS} />);
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('renders nothing when there are zero rejected invoices', () => {
    const { container } = render(<GateFailuresPanel rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
