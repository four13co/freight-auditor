import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientAuditLogView } from '../src/components/ClientAuditLogView.js';
import type { ClientPortalAuditEventRow } from '../src/lib/api.js';

function event(overrides: Partial<ClientPortalAuditEventRow>): ClientPortalAuditEventRow {
  return {
    id: 'e-1', entity: 'dispute', entityId: null, event: 'created', actorKind: 'analyst',
    recordedAt: '2026-01-15T00:00:00Z', ...overrides,
  };
}

const FULL_PAGE = Array.from({ length: 50 }, (_, i) => event({ id: `e-${i}`, actorKind: 'analyst' }));

describe('ClientAuditLogView (P6.B.6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount with the default page size and offset', async () => {
    render(<ClientAuditLogView />);
    expect(fetchMock).toHaveBeenCalledWith('/api/portal/audit-log?limit=50&offset=0', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('client-audit-log-empty')).toBeInTheDocument());
  });

  it('renders one row per event, with entity/event/actorKind visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      events: [
        event({ id: 'e-1', entity: 'dispute', event: 'created', actorKind: 'analyst' }),
        event({ id: 'e-2', entity: 'claim', event: 'opened', actorKind: 'system' }),
      ],
    }), { status: 200 }));
    render(<ClientAuditLogView />);

    await waitFor(() => expect(screen.getAllByTestId('client-audit-log-row')).toHaveLength(2));
    expect(screen.getByText('dispute')).toBeInTheDocument();
    expect(screen.getByText('created')).toBeInTheDocument();
    expect(screen.getByText('claim')).toBeInTheDocument();
    expect(screen.getByText('opened')).toBeInTheDocument();
  });

  // AC2: actorKind is visibly distinguishable per event, not collapsed or omitted.
  it('renders a distinct actorKind for each event', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      events: [
        event({ id: 'e-1', actorKind: 'analyst' }),
        event({ id: 'e-2', actorKind: 'ai' }),
        event({ id: 'e-3', actorKind: 'system' }),
        event({ id: 'e-4', actorKind: 'client' }),
      ],
    }), { status: 200 }));
    render(<ClientAuditLogView />);

    await waitFor(() => expect(screen.getAllByTestId('client-audit-log-actor-kind')).toHaveLength(4));
    const kinds = screen.getAllByTestId('client-audit-log-actor-kind').map((el) => el.textContent);
    expect(kinds).toEqual(['analyst', 'ai', 'system', 'client']);
  });

  // AC4: explicit empty state.
  it('shows an empty-state message when no events exist', async () => {
    render(<ClientAuditLogView />);
    await waitFor(() => expect(screen.getByTestId('client-audit-log-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-audit-log-table')).not.toBeInTheDocument();
  });

  // AC5: explicit error state.
  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientAuditLogView />);
    await waitFor(() => expect(screen.getByTestId('client-audit-log-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientAuditLogView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('disables Previous on the first page and Next when the page is not full', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events: [event({})] }), { status: 200 }));
    render(<ClientAuditLogView />);
    await waitFor(() => expect(screen.getByTestId('client-audit-log-prev')).toBeDisabled());
    expect(screen.getByTestId('client-audit-log-next')).toBeDisabled();
  });

  it('enables Next on a full page and advances offset on click', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ events: FULL_PAGE }), { status: 200 })));
    render(<ClientAuditLogView />);

    await waitFor(() => expect(screen.getByTestId('client-audit-log-next')).not.toBeDisabled());
    await user.click(screen.getByTestId('client-audit-log-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/portal/audit-log?limit=50&offset=50', expect.any(Object)));
    expect(screen.getByTestId('client-audit-log-prev')).not.toBeDisabled();
  });

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientAuditLogView />);
    const region = screen.getByTestId('client-audit-log-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-audit-log-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientAuditLogView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-audit-log-error');
  });

  // 86e2zfjx3 AC3: the empty container is role="status".
  it('marks the empty-state message role="status"', async () => {
    render(<ClientAuditLogView />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-audit-log-empty');
  });

  /**
   * 86e2zfjx3 AC5 (RTL substitute for the "e2e Playwright" wording -- see PR body's
   * Uncertainties: these 10 views are unwired to any route, so no page.goto() can reach
   * them without touching PortalApp.tsx, which is outside this task's 10 named files).
   * Proves the SAME live region present during the initial load persists across the page
   * change (never unmounts/remounts), which is what makes the announcement possible --
   * a region that disappears and reappears with new content does not announce.
   */
  it('reuses the same persistent aria-live region to announce a page change (AC5)', async () => {
    const user = userEvent.setup();
    const PAGE_2 = Array.from({ length: 50 }, (_, i) => event({ id: `page2-e-${i}`, entity: 'claim' }));
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(
      JSON.stringify({ events: url.includes('offset=50') ? PAGE_2 : FULL_PAGE }),
      { status: 200 },
    )));
    render(<ClientAuditLogView />);

    await waitFor(() => expect(screen.getByTestId('client-audit-log-next')).not.toBeDisabled());
    const region = screen.getByTestId('client-audit-log-live-region');
    const initialRows = screen.getAllByTestId('client-audit-log-row').map((r) => r.textContent);

    await user.click(screen.getByTestId('client-audit-log-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/portal/audit-log?limit=50&offset=50', expect.any(Object)));
    // Same DOM node throughout -- never unmounted between pages.
    expect(screen.getByTestId('client-audit-log-live-region')).toBe(region);
    await waitFor(() => {
      const updatedRows = screen.getAllByTestId('client-audit-log-row').map((r) => r.textContent);
      expect(updatedRows).not.toEqual(initialRows);
    });
  });
});
