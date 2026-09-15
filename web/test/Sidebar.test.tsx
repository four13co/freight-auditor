import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '../src/components/Sidebar.js';

/**
 * 86e38pz8e: the footer's UserMenu calls useSession()/signOut() directly --
 * mocked here (same pattern as App.test.tsx) so the pre-existing tests below
 * (none of which touch session data) never trigger a real network fetch.
 * devHeaderPathActive() defaults to true under Vitest (import.meta.env.DEV),
 * which is exactly the "no real session" state these pre-existing tests
 * implicitly render under -- unaffected by this mock either way.
 */
const useSessionMock = vi.fn().mockReturnValue({ data: null, isPending: false });
const signOutMock = vi.fn().mockResolvedValue({ error: null });
vi.mock('../src/lib/auth-client.js', () => ({
  useSession: () => useSessionMock(),
  signOut: () => signOutMock(),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    signOutMock.mockReset().mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('AC2: renders the default platform swatch, not a Customer logo, when no branding is configured', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('brand-mark-default')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
  });

  it("AC1: renders the Customer's logo instead of the platform swatch when branding is configured", () => {
    render(
      <Sidebar
        branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: '#222222' }}
      />,
    );
    expect(screen.getByTestId('brand-mark-logo')).toHaveAttribute('src', 'https://cdn.example.com/bank-a/logo.png');
    expect(screen.queryByTestId('brand-mark-default')).not.toBeInTheDocument();
  });

  it('86e36xk28 AC2: the header bottom border and footer top border are 1px (no border-b-2/border-t-2)', () => {
    render(<Sidebar />);
    const header = screen.getByTestId('sidebar-header');
    expect(header).not.toHaveClass('border-b-2');
    expect(header).toHaveClass('border-b');

    const footer = screen.getByTestId('sidebar-footer');
    expect(footer).not.toHaveClass('border-t-2');
    expect(footer).toHaveClass('border-t');
  });

  it('86e36xk28 AC3: nav item and saved-view labels no longer carry font-extrabold', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-active-item')).not.toHaveClass('font-extrabold');
    // 86e37r2rm/86e37r2rv/86e37r2rt/86e37r2t4/86e37r2t6/86e37r2t7/86e37r2t8:
    // "Discrepancies", "Audit log", "Invoices", "Settings", "Mine, over
    // $500", "Aging > 5 days", and "Estes accessorials" are now real <a>s,
    // not <button>s -- checked via .closest('a') below, same guarantee,
    // updated selector for the new DOM shape.
    for (const label of [
      'Discrepancies',
      'Audit log',
      'Invoices',
      'Claims',
      'Settings',
      'Mine, over $500',
      'Aging > 5 days',
      'Estes accessorials',
    ]) {
      expect(screen.getByText(label).closest('a')).not.toHaveClass('font-extrabold');
    }
  });

  it('86e36xk28 AC4: the active "Dashboard" row no longer sets a full opaque brand-color background fill', () => {
    render(<Sidebar />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active.style.backgroundColor).not.toBe('var(--brand-primary, #ec3013)');
    expect(active.className).not.toMatch(/\bbg-sidebar-bg\b/);
  });

  it('86e36xk28 AC5: the active row accent still resolves through var(--brand-primary, ...) when branding overrides it', () => {
    render(<Sidebar branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: '#222222' }} />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active.style.borderLeftColor).toBe('var(--brand-primary, #ec3013)');
  });

  it('86e37r2rm AC2: "Discrepancies" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Discrepancies').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rm: "Dashboard" stays the active item by default (currentPath prop omitted)', () => {
    render(<Sidebar />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Dashboard');
  });

  it('86e37r2rm: "Discrepancies" becomes the active item when currentPath is /discrepancies, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/discrepancies" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Discrepancies');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e387qpv AC3: "Claims" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Claims').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/claims');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e387qpv: "Claims" becomes the active item when currentPath is /claims, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/claims" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Claims');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2rv AC4: "Audit log" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Audit log').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/audit-log');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rv: "Audit log" becomes the active item when currentPath is /audit-log, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/audit-log" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Audit log');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2rt AC4: "Invoices" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Invoices').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/invoices');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rt: "Invoices" becomes the active item when currentPath is /invoices, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/invoices" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Invoices');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2t8 AC6: "Mine, over $500" is a real link to the assignee+minAmount preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Mine, over $500').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?assignee=me&minAmount=500');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t4 AC5: "Settings" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Settings').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/settings');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t7 AC4: "Estes accessorials" is a real link to the carrier+category preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Estes accessorials').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?carrier=Estes&category=accessorial');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t4: "Settings" becomes the active item when currentPath is /settings, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/settings" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Settings');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2t6 AC4: "Aging > 5 days" is a real link to the minAgeDays preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Aging > 5 days').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?minAgeDays=5');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e38pz8e: the footer no longer shows the hardcoded "Dana Mercer" placeholder', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Dana Mercer')).not.toBeInTheDocument();
    expect(screen.queryByText('Ops analyst · Four13')).not.toBeInTheDocument();
  });

  it('86e38pz8e: with no session (e.g. dev-header path), the user menu still renders with a generic identity and a working trigger', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('user-menu-trigger')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-initials')).toHaveTextContent('?');
  });

  it('86e38pz8e: shows the real session\'s name/email and initials when DEV is stubbed off', () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({ data: { user: { id: 'u1', name: 'Dana Mercer', email: 'dana@example.com', image: null } }, isPending: false });

    render(<Sidebar />);

    expect(screen.getByText('Dana Mercer')).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-initials')).toHaveTextContent('DM');
  });

  it('86e38pz8e: renders the session\'s avatar image instead of initials when one is set', () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({ data: { user: { id: 'u1', name: 'Dana Mercer', email: 'dana@example.com', image: 'https://cdn.example.com/avatar.png' } }, isPending: false });

    render(<Sidebar />);

    expect(screen.queryByTestId('user-menu-initials')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-menu-avatar')).toHaveAttribute('src', 'https://cdn.example.com/avatar.png');
  });

  it('86e38pz8e AC1: clicking the trigger opens a dropdown with Profile (-> #/profile) and Sign out', async () => {
    const user = userEvent.setup();
    render(<Sidebar />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('user-menu-trigger'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    const profileLink = screen.getByRole('menuitem', { name: 'Profile' });
    expect(profileLink).toHaveAttribute('href', '#/profile');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('86e38pz8e AC1: clicking Sign out calls signOut() and clears the stored client_id on success', async () => {
    sessionStorage.setItem('freight-auditor:client-id', 'c1');
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByTestId('user-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('freight-auditor:client-id')).toBeNull();
  });

  it('86e38pz8e: does not clear the stored client_id when signOut() itself errors', async () => {
    signOutMock.mockResolvedValue({ error: { message: 'network error' } });
    sessionStorage.setItem('freight-auditor:client-id', 'c1');
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByTestId('user-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(sessionStorage.getItem('freight-auditor:client-id')).toBe('c1');
  });
});
