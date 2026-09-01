import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ReconciliationExport } from '../src/components/ReconciliationExport.js';
import type { ReconciliationExportStatus } from '../src/lib/api.js';

const EXPORT_ID = '70000000-0000-4000-8000-000000000009';

const PENDING: ReconciliationExportStatus = {
  id: EXPORT_ID, status: 'pending', result: null, error: null, requestedAt: '2026-09-01T00:00:00.000Z', completedAt: null,
};
const COMPLETED: ReconciliationExportStatus = {
  id: EXPORT_ID,
  status: 'completed',
  result: [{ currency: 'USD', claimed: '500.0000', recovered: '500.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true }],
  error: null,
  requestedAt: '2026-09-01T00:00:00.000Z',
  completedAt: '2026-09-01T00:01:00.000Z',
};
const FAILED: ReconciliationExportStatus = {
  id: EXPORT_ID, status: 'failed', result: null, error: 'reconciliation export failed; contact support if this persists',
  requestedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
};
const EMPTY_COMPLETED: ReconciliationExportStatus = {
  id: EXPORT_ID, status: 'completed', result: [], error: null, requestedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
};

/**
 * Fake timers (for the component's setInterval poll) don't mix with RTL's
 * waitFor -- its own retry loop schedules against the same faked clock and
 * never resolves. So every assertion here follows an `act` flush (either a
 * bare `await act(async () => {})` to drain the microtask queue after a
 * fetch promise resolves, or an `act` wrapping `vi.advanceTimersByTimeAsync`
 * to also fire the next poll tick) instead of `waitFor`.
 */
describe('ReconciliationExport (P5.C.5)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('requests an export and polls until it completes, then renders the reconciliation table', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ exportId: EXPORT_ID, status: 'pending' }), { status: 202 }));
      const pollCalls = fetchMock.mock.calls.filter((c) => c[0] === url && (c[1] as RequestInit | undefined)?.method !== 'POST').length;
      return Promise.resolve(new Response(JSON.stringify(pollCalls <= 1 ? PENDING : COMPLETED), { status: 200 }));
    });

    render(<ReconciliationExport />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    });

    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeInTheDocument();
    expect(screen.getByText('Reconciling your portfolio…')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByTestId('reconciliation-export-table')).toBeInTheDocument();
    expect(screen.getAllByTestId('reconciliation-export-row')).toHaveLength(1);
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request export' })).not.toBeDisabled();
  });

  it('shows the error message and stops polling when the export fails', async () => {
    fetchMock.mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ exportId: EXPORT_ID, status: 'pending' }), { status: 202 }));
      return Promise.resolve(new Response(JSON.stringify(FAILED), { status: 200 }));
    });

    render(<ReconciliationExport />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    });
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByTestId('reconciliation-export-error')).toBeInTheDocument();
    expect(screen.getByText(/reconciliation export failed/)).toBeInTheDocument();

    const pollCountAtFailure = fetchMock.mock.calls.filter((c) => c[0] === `/api/reconciliation-exports/${EXPORT_ID}`).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock.mock.calls.filter((c) => c[0] === `/api/reconciliation-exports/${EXPORT_ID}`)).toHaveLength(pollCountAtFailure);
  });

  it('shows an empty state when reconciliation finds nothing to reconcile', async () => {
    fetchMock.mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ exportId: EXPORT_ID, status: 'pending' }), { status: 202 }));
      return Promise.resolve(new Response(JSON.stringify(EMPTY_COMPLETED), { status: 200 }));
    });

    render(<ReconciliationExport />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    });
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByText('No claims to reconcile.')).toBeInTheDocument();
  });

  it('shows a request error and re-enables the button when the POST fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    render(<ReconciliationExport />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    });

    expect(screen.getByText(/Couldn.t request export/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request export' })).not.toBeDisabled();
  });
});
