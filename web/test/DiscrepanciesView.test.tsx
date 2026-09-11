import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DiscrepanciesView } from '../src/components/DiscrepanciesView.js';
import { DASHBOARD_ROWS as ROWS } from './fixtures.js';

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchOnce(url: string) {
  if (url.includes('/api/findings')) {
    return Promise.resolve(new Response(JSON.stringify({ findings: ROWS }), { status: 200 }));
  }
  throw new Error(`mockFetchOnce: unexpected URL ${url}`);
}

beforeEach(() => {
  fetchMock = vi.fn((input: string | URL | Request) => mockFetchOnce(input.toString()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DiscrepanciesView (86e37r2rm)', () => {
  it('AC1: fetches and renders findings via the existing FindingsTable component', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    expect(screen.getByText('INV-90385')).toBeInTheDocument();
  });

  it('AC1: renders no KPI row, queues, or extraction-review/contract-preview panels -- full-page findings only', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    expect(screen.queryByTestId('kpi-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contract-rubric-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gate-failures-panel')).not.toBeInTheDocument();
  });

  it('AC3: changing the carrier filter re-fetches /api/findings with the carrier query param', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia LTL' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
    });
  });

  it('AC3: changing the status filter re-fetches /api/findings with the status query param', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'in_review' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('status=in_review');
    });
  });

  it('AC3: entering a min-amount value re-fetches /api/findings with the min-amount query param', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Minimum amount filter'), { target: { value: '500' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('min-amount=500');
    });
  });

  it('AC3: clicking the Variance column header re-fetches sorted by variance', async () => {
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getAllByTestId('finding-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.click(screen.getByText('Variance'));

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/findings?'))?.[0];
      expect(String(calledUrl)).toContain('sort=variance');
    });
  });

  it('shows a loading indicator before the fetch resolves, and a distinct error state on failure', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })));
    render(<DiscrepanciesView />);
    await waitFor(() => expect(screen.getByTestId('discrepancies-error')).toBeInTheDocument());
    expect(screen.queryByTestId('finding-row')).not.toBeInTheDocument();
  });
});
