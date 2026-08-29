import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RecoveryReport } from '../src/components/RecoveryReport.js';
import type { RecoveryReportBucket } from '../src/lib/api.js';

const BUCKETS: RecoveryReportBucket[] = [
  { currency: 'USD', claimed: '1250.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '250.0000', reconciles: true },
];

describe('RecoveryReport (P5.C.2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and renders one bucket per currency', async () => {
    render(<RecoveryReport />);

    expect(fetchMock).toHaveBeenCalledWith('/api/recovery-report', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('recovery-report-bucket')).toHaveLength(1));
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('$1,250.00')).toBeInTheDocument();
    expect(screen.getByText('$600.00')).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });

  it('renders one row per currency when multiple currencies are present', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      buckets: [
        BUCKETS[0]!,
        { currency: 'CAD', claimed: '200.0000', recovered: '0.0000', outstanding: '200.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true },
      ],
    }), { status: 200 }));

    render(<RecoveryReport />);
    await waitFor(() => expect(screen.getAllByTestId('recovery-report-bucket')).toHaveLength(2));
  });

  it('shows a non-reconciling bucket with a warning', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      buckets: [{ ...BUCKETS[0]!, reconciles: false }],
    }), { status: 200 }));

    render(<RecoveryReport />);
    await waitFor(() => expect(screen.getByTestId('reconciliation-warning')).toBeInTheDocument());
  });

  it('shows an empty state when there are no claims yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<RecoveryReport />);
    await waitFor(() => expect(screen.getByText('No claims yet.')).toBeInTheDocument());
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<RecoveryReport />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load recovery report/)).toBeInTheDocument());
  });
});
