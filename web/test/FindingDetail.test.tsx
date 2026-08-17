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
});
