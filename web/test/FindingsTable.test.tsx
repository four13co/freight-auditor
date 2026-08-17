import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { FindingsTable } from '../src/components/FindingsTable.js';
import type { FindingRow } from '../src/lib/api.js';

const ROWS: FindingRow[] = [
  {
    id: 'f1',
    invoiceNumber: 'INV-A',
    carrierName: 'Saia LTL',
    billed: '10.0000',
    expected: '0.0000',
    varianceAmount: '10.00',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-10T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f2',
    invoiceNumber: 'INV-B',
    carrierName: 'Old Dominion',
    billed: '9.0000',
    expected: '0.0000',
    varianceAmount: '9.00',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-12T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f3',
    invoiceNumber: 'INV-C',
    carrierName: 'XPO Logistics',
    billed: '5.0000',
    expected: '10.0000',
    varianceAmount: '-5.00',
    direction: 'UNDERCHARGE',
    status: 'open',
    createdAt: '2026-08-08T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f4',
    invoiceNumber: 'INV-D',
    carrierName: 'FedEx Freight',
    billed: '3.0000',
    expected: null,
    varianceAmount: null,
    direction: 'INTEGRITY_ONLY',
    status: 'open',
    createdAt: '2026-08-11T00:00:00Z',
    ruleDescription: null,
  },
];

function invoiceOrder() {
  return screen.getAllByTestId('finding-row').map((row) => within(row).getByText(/^INV-/).textContent);
}

function renderTable() {
  render(
    <FindingsTable
      rows={ROWS}
      carrierFilter=""
      statusFilter=""
      onCarrierFilterChange={() => {}}
      onStatusFilterChange={() => {}}
      minAmountFilter=""
      onMinAmountFilterChange={() => {}}
    />,
  );
}

describe('FindingsTable selection count/total (86e2v250p)', () => {
  it('AC1: a filter change that drops a selected row from `rows` shrinks both the count and the dollar total to match', () => {
    const { rerender } = render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    fireEvent.click(screen.getByLabelText('Select finding INV-B'));
    expect(screen.getByText(/2 selected · \$19\.00/)).toBeInTheDocument();

    // Simulate a filter change: the parent re-renders with a narrower `rows`
    // that no longer includes INV-B (still selected in local state).
    const narrowedRows = ROWS.filter((r) => r.id !== 'f2');
    rerender(
      <FindingsTable
        rows={narrowedRows}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
      />,
    );

    expect(screen.getByText(/1 selected · \$10\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/2 selected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$19\.00/)).not.toBeInTheDocument();
  });

  it('AC2: existing selection test (single select, no filter change) still passes', () => {
    renderTable();
    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    expect(screen.getByText(/1 selected · \$10\.00/)).toBeInTheDocument();
  });
});

describe('FindingsTable sorting (86e2uuw63)', () => {
  it('AC1: clicking Variance sorts numerically ascending, then descending on a second click', () => {
    renderTable();
    // -5.00 (f3) < 9.00 (f2) < 10.00 (f1) numerically -- a lexicographic sort
    // would put "10.00" before "9.00".
    fireEvent.click(screen.getByText('Variance'));
    expect(invoiceOrder()).toEqual(['INV-C', 'INV-B', 'INV-A', 'INV-D']);

    fireEvent.click(screen.getByText(/Variance/));
    expect(invoiceOrder()).toEqual(['INV-A', 'INV-B', 'INV-C', 'INV-D']);
  });

  it('AC2: clicking Age sorts chronologically, toggling direction on repeat clicks', () => {
    renderTable();
    fireEvent.click(screen.getByText('Age'));
    expect(invoiceOrder()).toEqual(['INV-C', 'INV-A', 'INV-D', 'INV-B']);

    fireEvent.click(screen.getByText(/Age/));
    expect(invoiceOrder()).toEqual(['INV-B', 'INV-D', 'INV-A', 'INV-C']);
  });

  it('AC3: a row with varianceAmount: null renders last regardless of sort direction', () => {
    renderTable();
    fireEvent.click(screen.getByText('Variance'));
    expect(invoiceOrder().at(-1)).toBe('INV-D');

    fireEvent.click(screen.getByText(/Variance/));
    expect(invoiceOrder().at(-1)).toBe('INV-D');
  });

  it('AC4: carrier/status filters and selection behavior are unaffected by sorting', () => {
    const onCarrierFilterChange = vi.fn();
    render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={onCarrierFilterChange}
        onStatusFilterChange={() => {}}
      minAmountFilter=""
      onMinAmountFilterChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('Variance'));
    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia' } });
    expect(onCarrierFilterChange).toHaveBeenCalledWith('Saia');

    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });
});
