import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientRecoveryReport } from '../src/components/ClientRecoveryReport.js';
import type { ClientRecoveryReportBucket } from '../src/lib/api.js';

const BUCKETS: ClientRecoveryReportBucket[] = [
  {
    currency: 'USD',
    claimed: '1250.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '250.0000',
    nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true,
  },
];

describe('ClientRecoveryReport (P5.C.2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and renders one row per currency bucket', async () => {
    render(<ClientRecoveryReport />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portfolio/recovery-report', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-recovery-report-row')).toHaveLength(1));
    expect(screen.getByText('1,250.00 USD')).toBeInTheDocument();
    expect(screen.getByText('400.00 USD')).toBeInTheDocument();
  });

  it('shows an empty-state message when no claims exist', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<ClientRecoveryReport />);
    await waitFor(() => expect(screen.getByTestId('client-recovery-report-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-recovery-report-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientRecoveryReport />);
    await waitFor(() => expect(screen.getByTestId('client-recovery-report-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientRecoveryReport />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientRecoveryReport />);
    const region = screen.getByTestId('client-recovery-report-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-recovery-report-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientRecoveryReport />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-recovery-report-error');
  });

  // 86e2zfjx3 AC3: the empty container is role="status".
  it('marks the empty-state message role="status"', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<ClientRecoveryReport />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-recovery-report-empty');
  });

  it('clears aria-busy once the fetch resolves', async () => {
    render(<ClientRecoveryReport />);
    await waitFor(() => expect(screen.getByTestId('client-recovery-report-live-region')).toHaveAttribute('aria-busy', 'false'));
  });
});
