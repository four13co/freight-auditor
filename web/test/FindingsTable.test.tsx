import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { FindingsTable } from '../src/components/FindingsTable.js';
import { SORTABLE_ROWS as ROWS } from './fixtures.js';

function invoiceOrder() {
  return screen.getAllByTestId('finding-row').map((row) => within(row).getByText(/^INV-/).textContent);
}

function renderTable(props: Partial<React.ComponentProps<typeof FindingsTable>> = {}) {
  render(
    <FindingsTable
      rows={ROWS}
      carrierFilter=""
      statusFilter=""
      onCarrierFilterChange={() => {}}
      onStatusFilterChange={() => {}}
      minAmountFilter=""
      onMinAmountFilterChange={() => {}}
      sort={null}
      onSortChange={() => {}}
      {...props}
    />,
  );
}

// 86e2v251e: sort moved server-side (Dashboard.tsx now owns the sort state
// and re-fetches from the backend) -- FindingsTable is no longer the thing
// that orders `rows`, so it can no longer be the thing proving numeric vs.
// lexicographic ordering or null-last placement. Those guarantees now live
// where the actual ordering happens: list-findings.db.test.ts (real ORDER BY
// against real data) and list-findings.test.ts (the NULLS LAST SQL clause).
// What THIS component still owns and must keep proving: clicking a sort
// header reports the click upward (the callback contract), the arrow
// reflects whatever sort state it's given, and neither is entangled with
// filters/selection.
describe('FindingsTable sorting (86e2uuw63, updated for 86e2v251e)', () => {
  it('clicking Variance calls onSortChange with "variance"', () => {
    const onSortChange = vi.fn();
    renderTable({ onSortChange });
    fireEvent.click(screen.getByText('Variance'));
    expect(onSortChange).toHaveBeenCalledWith('variance');
  });

  it('clicking Age calls onSortChange with "age"', () => {
    const onSortChange = vi.fn();
    renderTable({ onSortChange });
    fireEvent.click(screen.getByText('Age'));
    expect(onSortChange).toHaveBeenCalledWith('age');
  });

  it('renders the ↑ arrow for an ascending sort and ↓ for descending, on the active column only', () => {
    const { rerender } = render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={{ key: 'variance', dir: 'asc' }}
        onSortChange={() => {}}
      />,
    );
    expect(screen.getByText('Variance ↑')).toBeInTheDocument();
    expect(screen.getByText('Age')).toBeInTheDocument(); // no arrow -- not the active column

    rerender(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={{ key: 'variance', dir: 'desc' }}
        onSortChange={() => {}}
      />,
    );
    expect(screen.getByText('Variance ↓')).toBeInTheDocument();
  });

  it('renders rows in whatever order the `rows` prop arrives in (no local re-sorting)', () => {
    // ROWS' natural fixture order is f1, f2, f3, f4 (INV-A, INV-B, INV-C,
    // INV-D) -- proving the component doesn't quietly re-sort them itself
    // regardless of the `sort` prop's value.
    renderTable({ sort: { key: 'variance', dir: 'desc' } });
    expect(invoiceOrder()).toEqual(['INV-A', 'INV-B', 'INV-C', 'INV-D']);
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
        sort={null}
        onSortChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('Variance'));
    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia' } });
    expect(onCarrierFilterChange).toHaveBeenCalledWith('Saia');

    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });
});

describe('FindingsTable selection count/total sync on rows change (86e2v250p)', () => {
  it('AC1: shrinks both the count and the dollar total when a filter change removes a selected row from `rows`', () => {
    const { rerender } = render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    // Select INV-A ($10.00) and INV-B ($9.00). The count + total live in one
    // <span>, so match on its combined text content rather than separately --
    // "$9.00" alone also matches an unrelated row's own billed/expected cell.
    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    fireEvent.click(screen.getByLabelText('Select finding INV-B'));
    expect(screen.getByText('2 selected · $19.00')).toBeInTheDocument();

    // Simulate a filter change: Dashboard re-fetches and passes a smaller
    // `rows` prop that no longer includes INV-A -- `selected` (the Set) is
    // untouched, exactly reproducing the bug's precondition.
    rerender(
      <FindingsTable
        rows={ROWS.filter((r) => r.id !== 'f1')}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    // Only INV-B ($9.00) is still present and selected -- count and total
    // must agree on that, not "2 selected" alongside a $9.00 total.
    expect(screen.getByText('1 selected · $9.00')).toBeInTheDocument();
    expect(screen.queryByText(/2 selected/)).not.toBeInTheDocument();
  });

  it('AC1b: hides the bulk-action bar entirely once every selected row has been filtered out of `rows`', () => {
    const { rerender } = render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();

    // INV-A -- the only selected row -- is no longer in the new rows prop.
    rerender(
      <FindingsTable
        rows={ROWS.filter((r) => r.id !== 'f1')}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('AC2: existing selection tests still pass unmodified', () => {
    render(
      <FindingsTable
        rows={ROWS}
        carrierFilter=""
        statusFilter=""
        onCarrierFilterChange={() => {}}
        onStatusFilterChange={() => {}}
        minAmountFilter=""
        onMinAmountFilterChange={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select finding INV-A'));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });
});
