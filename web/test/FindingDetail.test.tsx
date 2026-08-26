import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FindingDetail } from '../src/components/FindingDetail.js';
import { DASHBOARD_ROWS } from './fixtures.js';

const ROW = DASHBOARD_ROWS[0]!; // status: 'open'

describe('FindingDetail status control (86e2v1xyr)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC3: selecting a new status calls the PATCH endpoint and updates the displayed value without a page reload', async () => {
    render(<FindingDetail row={ROW} onClose={() => {}} />);

    const select = screen.getByLabelText('Finding status') as HTMLSelectElement;
    expect(select.value).toBe('open');

    fireEvent.change(select, { target: { value: 'in_review' } });

    await waitFor(() => expect(select.value).toBe('in_review'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/findings/${ROW.id}/status`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ status: 'in_review' });
  });

  it('only offers the 5 filterable statuses as selectable options', () => {
    render(<FindingDetail row={ROW} onClose={() => {}} />);
    const select = screen.getByLabelText('Finding status') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['open', 'in_review', 'queued_for_dispute', 'disputed', 'closed']);
  });

  it('calls onStatusChange after a successful transition', async () => {
    const onStatusChange = vi.fn();
    render(<FindingDetail row={ROW} onClose={() => {}} onStatusChange={onStatusChange} />);
    fireEvent.change(screen.getByLabelText('Finding status'), { target: { value: 'closed' } });
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(ROW.id, 'closed'));
  });

  it('reverts to the previous status and shows an error when the PATCH fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<FindingDetail row={ROW} onClose={() => {}} />);
    const select = screen.getByLabelText('Finding status') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'in_review' } });

    await waitFor(() => expect(screen.getByText(/Couldn.t update status/)).toBeInTheDocument());
    expect(select.value).toBe('open');
  });

  it('navigates from a finding to its per-invoice scorecard', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ audit_run_id: 'run-1', invoice_id: 'inv-1',
      invoice_number: 'INV-1', outcome: 'SCORED', conformed_count: 4, variance_count: 2,
      unassessable_count: 1, total_overcharge: '12.5000', total_undercharge: '2.0000', currency: 'USD' }), { status: 200 }));
    render(<FindingDetail row={{ ...ROW, auditRunId: 'run-1', invoiceId: 'inv-1' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'View scorecard' }));
    await waitFor(() => expect(screen.getByTestId('invoice-scorecard')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/audit-runs/run-1/scorecard', expect.any(Object));
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
