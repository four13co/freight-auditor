import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogView } from '../src/components/AuditLogView.js';
import type { AuditLogEventRow } from '../src/lib/api.js';

function event(overrides: Partial<AuditLogEventRow>): AuditLogEventRow {
  return {
    id: 'e-1', entity: 'dispute', entityId: null, event: 'created', actorKind: 'analyst',
    recordedAt: '2026-01-15T00:00:00Z', ...overrides,
  };
}

const FULL_PAGE = Array.from({ length: 50 }, (_, i) => event({ id: `e-${i}`, actorKind: 'analyst' }));

describe('AuditLogView (86e37r2rv)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount with the default page size and offset', async () => {
    render(<AuditLogView />);
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/audit-log?limit=50&offset=0', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('audit-log-empty')).toBeInTheDocument());
  });

  it('renders one row per event, with entity/event/actorKind visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      events: [
        event({ id: 'e-1', entity: 'dispute', event: 'created', actorKind: 'analyst' }),
        event({ id: 'e-2', entity: 'claim', event: 'opened', actorKind: 'system' }),
      ],
    }), { status: 200 }));
    render(<AuditLogView />);

    await waitFor(() => expect(screen.getAllByTestId('audit-log-row')).toHaveLength(2));
    expect(screen.getByText('dispute')).toBeInTheDocument();
    expect(screen.getByText('created')).toBeInTheDocument();
    expect(screen.getByText('claim')).toBeInTheDocument();
    expect(screen.getByText('opened')).toBeInTheDocument();
  });

  it('renders a distinct actorKind for each event', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      events: [
        event({ id: 'e-1', actorKind: 'analyst' }),
        event({ id: 'e-2', actorKind: 'ai' }),
        event({ id: 'e-3', actorKind: 'system' }),
        event({ id: 'e-4', actorKind: 'client' }),
      ],
    }), { status: 200 }));
    render(<AuditLogView />);

    await waitFor(() => expect(screen.getAllByTestId('audit-log-actor-kind')).toHaveLength(4));
    const kinds = screen.getAllByTestId('audit-log-actor-kind').map((el) => el.textContent);
    expect(kinds).toEqual(['analyst', 'ai', 'system', 'client']);
  });

  it('shows an empty-state message when no events exist', async () => {
    render(<AuditLogView />);
    await waitFor(() => expect(screen.getByTestId('audit-log-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('audit-log-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<AuditLogView />);
    await waitFor(() => expect(screen.getByTestId('audit-log-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<AuditLogView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries the load when Retry is clicked after an error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<AuditLogView />);
    await waitFor(() => expect(screen.getByTestId('audit-log-error')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [event({})] }), { status: 200 }));
    await user.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getAllByTestId('audit-log-row')).toHaveLength(1));
    expect(screen.queryByTestId('audit-log-error')).not.toBeInTheDocument();
  });

  it('disables Previous on the first page and Next when the page is not full', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events: [event({})] }), { status: 200 }));
    render(<AuditLogView />);
    await waitFor(() => expect(screen.getByTestId('audit-log-prev')).toBeDisabled());
    expect(screen.getByTestId('audit-log-next')).toBeDisabled();
  });

  it('enables Next on a full page and advances offset on click', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ events: FULL_PAGE }), { status: 200 })));
    render(<AuditLogView />);

    await waitFor(() => expect(screen.getByTestId('audit-log-next')).not.toBeDisabled());
    await user.click(screen.getByTestId('audit-log-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/internal/audit-log?limit=50&offset=50', expect.any(Object)));
    expect(screen.getByTestId('audit-log-prev')).not.toBeDisabled();
  });
});
