import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '../src/components/Dashboard.js';
import type { FindingRow, FindingsSummary } from '../src/lib/api.js';

const SUMMARY: FindingsSummary = {
  recoverableOpen: '148320.0000',
  flaggedToday: 42,
  withCarriers: 27,
  recoveredLast30Days: '96411.0000',
};

const ROWS: FindingRow[] = [
  {
    id: 'f1',
    invoiceNumber: 'INV-90385',
    carrierName: 'Saia LTL',
    billed: '1876.4000',
    expected: '0.0000',
    varianceAmount: '1876.4000',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: 'Duplicate invoice for the same PRO',
  },
  {
    id: 'f2',
    invoiceNumber: 'INV-90408',
    carrierName: 'Old Dominion',
    billed: '5940.2000',
    expected: '5118.6000',
    varianceAmount: '821.6000',
    direction: 'OVERCHARGE',
    status: 'in_review',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: 'Fuel surcharge above the indexed rate',
  },
  {
    id: 'f3',
    invoiceNumber: 'INV-90331',
    carrierName: 'XPO Logistics',
    billed: '2077.3000',
    expected: null,
    varianceAmount: null,
    direction: 'INTEGRITY_ONLY',
    status: 'open',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: null,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchOnce(url: string) {
  if (url.includes('/api/findings/summary')) {
    return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ findings: ROWS }), { status: 200 }));
}

beforeEach(() => {
  fetchMock = vi.fn((input: string | URL | Request) => mockFetchOnce(input.toString()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dashboard', () => {
  it('AC1: renders N rows with correct billed/expected/variance/status display', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });
    const [row1, row2, row3] = foundRows;

    expect(within(row1!).getByText('$1,876.40')).toBeInTheDocument(); // f1 billed
    expect(within(row1!).getByText('+$1,876.40')).toBeInTheDocument(); // f1 variance
    expect(within(row1!).getByText('Queued')).toBeInTheDocument(); // f1: status=open -> Queued
    expect(within(row2!).getByText('In review')).toBeInTheDocument(); // f2: status=in_review
    expect(within(row3!).getByText('Needs data')).toBeInTheDocument(); // f3: expected=null
    expect(within(row3!).getByText('n/a')).toBeInTheDocument(); // f3 variance (null)
    // f3 has TWO null-driven em-dash placeholders now (Expected, and Finding
    // per 86e2up8c8 -- ruleDescription is also null for this row): assert
    // count, not getByText, since getByText requires exactly one match.
    expect(within(row3!).getAllByText('—')).toHaveLength(2);
  });

  it('86e2up8c8 AC1: a row with a populated ruleDescription shows that exact text in the Finding column', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });
    const [row1, row2] = foundRows;
    // The Finding cell is the row's 3rd direct child (checkbox, Invoice,
    // Finding, ...) -- check it directly so this fails if the text renders
    // in some other column instead of the intended one.
    expect(row1!.children[2]).toHaveTextContent('Duplicate invoice for the same PRO');
    expect(row2!.children[2]).toHaveTextContent('Fuel surcharge above the indexed rate');
  });

  it('86e2up8c8 AC2: a row with ruleDescription: null shows the placeholder, not a blank cell or "null"', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });
    const [, , row3] = foundRows;
    expect(within(row3!).queryByText('null')).not.toBeInTheDocument();
    // The Finding cell is the row's 3rd direct child (checkbox, Invoice,
    // Finding, ...) -- check it directly, not via a text-content count that
    // could pass even if the placeholder landed in the wrong column.
    const findingCell = row3!.children[2];
    expect(findingCell).toHaveTextContent('—');
  });

  it('AC4: KPI endpoint values display in the 4 KPI cards exactly', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByTestId('kpi-row')).toBeInTheDocument());

    expect(screen.getByText('$148,320.00')).toBeInTheDocument(); // recoverableOpen
    expect(screen.getByText('42')).toBeInTheDocument(); // flaggedToday
    expect(screen.getByText('27')).toBeInTheDocument(); // withCarriers
    expect(screen.getByText('$96,411.00')).toBeInTheDocument(); // recoveredLast30Days
  });

  it('AC2: selecting 2+ rows shows the selection bar with count + summed amount', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    fireEvent.click(screen.getByLabelText('Select finding INV-90385')); // +1876.40
    fireEvent.click(screen.getByLabelText('Select finding INV-90408')); // +821.60

    await waitFor(() => {
      expect(screen.getByText(/2 selected/)).toBeInTheDocument();
    });
    expect(screen.getByText(/\$2,698\.00/)).toBeInTheDocument(); // 1876.40 + 821.60 = 2698.00
  });

  it('AC3: changing the carrier filter re-fetches /api/findings with the carrier query param', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia LTL' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
    });
  });

  it('AC3: changing the status filter re-fetches /api/findings with the status query param', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'in_review' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('status=in_review');
    });
  });

  it('86e2uuw7k AC1: entering a min-amount value re-fetches /api/findings with the min-amount query param', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Minimum amount filter'), { target: { value: '500' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('min-amount=500');
    });
  });

  it('86e2uuw7k AC2: carrier, status, and min-amount filters all persist together in the same refetch', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia LTL' } });
    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
    });

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'in_review' } });
    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
      expect(String(calledUrl)).toContain('status=in_review');
    });

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('Minimum amount filter'), { target: { value: '500' } });
    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
      expect(String(calledUrl)).toContain('status=in_review');
      expect(String(calledUrl)).toContain('min-amount=500');
    });
  });

  it('86e2uuw7k AC3: clearing the min-amount filter omits min-amount from the refetch', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Minimum amount filter'), { target: { value: '500' } });
    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('min-amount=500');
    });

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('Minimum amount filter'), { target: { value: '' } });
    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'));
      // Either no query string at all, or one that omits min-amount.
      expect(calledUrl === undefined || !String(calledUrl).includes('min-amount')).toBe(true);
    });
  });

  it('bulk-action buttons are visible but disabled (no backing write endpoint yet)', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fireEvent.click(screen.getByLabelText('Select finding INV-90385'));

    await waitFor(() => expect(screen.getByText('Open disputes')).toBeInTheDocument());
    expect(screen.getByText('Open disputes').closest('button')).toBeDisabled();
    expect(screen.getByText('Assign').closest('button')).toBeDisabled();
    expect(screen.getByText('Dismiss').closest('button')).toBeDisabled();
  });

  it('86e2uuw7t AC2: renders "No findings match these filters." when a filter is active and zero rows come back', async () => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/api/findings/summary')) {
        return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText('No findings yet.')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia LTL' } });

    await waitFor(() => expect(screen.getByText('No findings match these filters.')).toBeInTheDocument());
  });

  it('86e2uuw7t AC1: renders a distinct "No findings yet." message for a brand-new tenant with zero rows and no filters active', async () => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/api/findings/summary')) {
        return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText('No findings yet.')).toBeInTheDocument());
    expect(screen.queryByText('No findings match these filters.')).not.toBeInTheDocument();
  });

  it('86e2urn2t: shows a loading indicator before the initial fetches resolve', async () => {
    let resolveSummary!: (res: Response) => void;
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/api/findings/summary')) {
        return new Promise((resolve) => {
          resolveSummary = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    });

    render(<Dashboard />);
    expect(screen.getByTestId('dashboard-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-row')).not.toBeInTheDocument();

    resolveSummary(new Response(JSON.stringify(SUMMARY), { status: 200 }));
    await waitFor(() => expect(screen.queryByTestId('dashboard-loading')).not.toBeInTheDocument());
  });

  it('86e2urn2t: shows a distinct error state (not the empty-table markup) when a fetch rejects', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })));

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByTestId('dashboard-error')).toBeInTheDocument());

    // Must NOT render the same markup a genuinely-empty tenant would show --
    // that's the exact ambiguity this item exists to remove.
    expect(screen.queryByText('No findings match these filters.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-row')).not.toBeInTheDocument();
  });

  it('86e2urn2t: retrying after an error re-fetches, and success clears the error state', async () => {
    let callCount = 0;
    fetchMock.mockImplementation((input: string | URL | Request) => {
      callCount += 1;
      // First render's two calls (summary + findings) both fail; the retry's
      // two calls both succeed.
      if (callCount <= 2) {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      const url = input.toString();
      if (url.includes('/api/findings/summary')) {
        return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ findings: ROWS }), { status: 200 }));
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByTestId('dashboard-error')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getByTestId('kpi-row')).toBeInTheDocument());
    expect(screen.queryByTestId('dashboard-error')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('finding-row')).toHaveLength(3);
  });

  it('86e2uutk8 AC1: clicking a row opens a detail view showing that row\'s own values, not any row\'s', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });

    fireEvent.click(foundRows[0]!);

    const detail = await waitFor(() => screen.getByTestId('finding-detail'));
    expect(within(detail).getByText('INV-90385')).toBeInTheDocument();
    expect(within(detail).getByText('Saia LTL')).toBeInTheDocument();
    expect(within(detail).getByText('Duplicate invoice for the same PRO')).toBeInTheDocument();
    expect(within(detail).getByText('$1,876.40')).toBeInTheDocument(); // billed
    expect(within(detail).getByText('+$1,876.40')).toBeInTheDocument(); // variance
    expect(within(detail).getByText('OVERCHARGE')).toBeInTheDocument(); // direction
    // Not row2's invoice number, to prove this is row-specific, not a fixed panel.
    expect(within(detail).queryByText('INV-90408')).not.toBeInTheDocument();
  });

  it('86e2uutk8 AC2: closing the detail via its close button restores the closed state', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });

    fireEvent.click(foundRows[0]!);
    await waitFor(() => expect(screen.getByTestId('finding-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Close finding detail'));
    expect(screen.queryByTestId('finding-detail')).not.toBeInTheDocument();
  });

  it('86e2uutk8 AC2: closing the detail via Escape restores the closed state', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });

    fireEvent.click(foundRows[0]!);
    await waitFor(() => expect(screen.getByTestId('finding-detail')).toBeInTheDocument());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('finding-detail')).not.toBeInTheDocument();
  });

  it('86e2uutk8 AC3: a finding with null expected/varianceAmount renders the existing empty-value treatment, not "null"/"undefined"/blank', async () => {
    render(<Dashboard />);
    const foundRows = await waitFor(() => {
      const found = screen.getAllByTestId('finding-row');
      expect(found).toHaveLength(3);
      return found;
    });

    fireEvent.click(foundRows[2]!); // f3: expected null, varianceAmount null, ruleDescription null

    const detail = await waitFor(() => screen.getByTestId('finding-detail'));
    expect(within(detail).queryByText('null')).not.toBeInTheDocument();
    expect(within(detail).queryByText('undefined')).not.toBeInTheDocument();
    expect(within(detail).getByText('n/a')).toBeInTheDocument(); // varianceAmount
    // Expected and Finding are both null-driven em-dashes here.
    expect(within(detail).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('86e2uutk8: clicking a row\'s checkbox toggles selection without opening the detail view', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    fireEvent.click(screen.getByLabelText('Select finding INV-90385'));

    await waitFor(() => expect(screen.getByText(/1 selected/)).toBeInTheDocument());
    expect(screen.queryByTestId('finding-detail')).not.toBeInTheDocument();
  });

  it('86e2uutk8 AC4: sidebar entries are visibly non-interactive (disabled), not fake-clickable chrome', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    expect(screen.getByText('Discrepancies').closest('button')).toBeDisabled();
    expect(screen.getByText('Invoices').closest('button')).toBeDisabled();
    expect(screen.getByText('Audit log').closest('button')).toBeDisabled();
    expect(screen.getByText('Settings').closest('button')).toBeDisabled();
    expect(screen.getByText('Mine, over $500').closest('button')).toBeDisabled();
    expect(screen.getByText('Estes accessorials').closest('button')).toBeDisabled();
    expect(screen.getByText('Aging > 5 days').closest('button')).toBeDisabled();
  });

  it('86e2uv1r6 AC1: the header search field is a real disabled input, not an inert div', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    const search = screen.getByPlaceholderText('Search invoice, PRO, or claim ID');
    expect(search.tagName).toBe('INPUT');
    expect(search).toBeDisabled();
  });

  it('86e2uv1r6 AC2: the Export and New audit run controls are disabled buttons', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    expect(screen.getByText('Export').closest('button')).toBeDisabled();
    expect(screen.getByText('New audit run').closest('button')).toBeDisabled();
  });

  it('86e2uv1r6 AC3: typing into the search field is rejected (disabled input accepts no input)', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));

    // userEvent.type (unlike fireEvent.change) simulates real keystrokes and
    // respects the disabled attribute -- fireEvent.change bypasses that and
    // sets the DOM value directly, which would pass even on a broken input.
    const search = screen.getByPlaceholderText('Search invoice, PRO, or claim ID') as HTMLInputElement;
    await userEvent.type(search, 'INV-90385');
    expect(search.value).toBe('');
  });
});
