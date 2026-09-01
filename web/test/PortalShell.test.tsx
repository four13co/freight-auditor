import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortalShell } from '../src/components/PortalShell.js';

describe('PortalShell (P6.A.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading state before the overview resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<PortalShell />);
    expect(screen.getByTestId('portal-shell-loading')).toBeInTheDocument();
  });

  it('fetches the tenant overview and greets the resolved client by name', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ clientName: 'Acme Bank' }), { status: 200 }));
    render(<PortalShell />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portal/overview', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('portal-shell-greeting')).toHaveTextContent('Welcome, Acme Bank'));
  });

  it('shows an error state when the overview fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<PortalShell />);
    await waitFor(() => expect(screen.getByTestId('portal-shell-error')).toBeInTheDocument());
  });

  it('shows an error state when the caller has no membership (404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<PortalShell />);
    await waitFor(() => expect(screen.getByTestId('portal-shell-error')).toBeInTheDocument());
  });

  it('renders every content nav item as a visibly disabled "Coming soon" placeholder', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ clientName: 'Acme Bank' }), { status: 200 }));
    render(<PortalShell />);
    await waitFor(() => expect(screen.getByTestId('portal-shell-greeting')).toBeInTheDocument());

    const navItems = screen.getAllByTestId('portal-nav-item');
    expect(navItems).toHaveLength(5);
    for (const item of navItems) {
      expect(item).toBeDisabled();
    }
  });
});
