import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TenantPicker } from '@/components/TenantPicker';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

const useTenantMock = vi.fn();
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => useTenantMock(),
}));

describe('TenantPicker', () => {
  it('AC: hidden for Grand Client and Vendor (no tenants to switch between)', () => {
    useAuthMock.mockReturnValue({ role: 'grand_client' });
    useTenantMock.mockReturnValue({ options: [], activeClient: null, setActiveClient: vi.fn(), isLoading: false });

    const { container } = render(<TenantPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('AC: hidden for a role with zero available tenants (graceful empty handling)', () => {
    useAuthMock.mockReturnValue({ role: 'employee' });
    useTenantMock.mockReturnValue({ options: [], activeClient: null, setActiveClient: vi.fn(), isLoading: false });

    const { container } = render(<TenantPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('AC: Employee can search and select a client', async () => {
    const setActiveClient = vi.fn();
    useAuthMock.mockReturnValue({ role: 'employee' });
    useTenantMock.mockReturnValue({
      options: [
        { id: 'c1', name: 'Acme Freight' },
        { id: 'c2', name: 'Beacon Logistics' },
      ],
      activeClient: { id: 'c1', name: 'Acme Freight' },
      setActiveClient,
      isLoading: false,
    });

    const user = userEvent.setup();
    render(<TenantPicker />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search clients…'), 'Beacon');

    await waitFor(() => expect(screen.getByText('Beacon Logistics')).toBeInTheDocument());
    await user.click(screen.getByText('Beacon Logistics'));

    expect(setActiveClient).toHaveBeenCalledWith({ id: 'c2', name: 'Beacon Logistics' });
  });

  it('AC: Account role can search and select their own Grand Client', async () => {
    const setActiveGrandClient = vi.fn();
    useAuthMock.mockReturnValue({ role: 'account' });
    useTenantMock.mockReturnValue({
      options: [
        { id: 'gc1', name: 'Grand Client One' },
        { id: 'gc2', name: 'Grand Client Two' },
      ],
      activeGrandClient: { id: 'gc1', name: 'Grand Client One' },
      setActiveGrandClient,
      isLoading: false,
    });

    const user = userEvent.setup();
    render(<TenantPicker />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search grand clients…'), 'Two');

    await waitFor(() => expect(screen.getByText('Grand Client Two')).toBeInTheDocument());
    await user.click(screen.getByText('Grand Client Two'));

    expect(setActiveGrandClient).toHaveBeenCalledWith({ id: 'gc2', name: 'Grand Client Two' });
  });

  it('AC: hidden for the Account role with zero Grand Clients (graceful empty handling)', () => {
    useAuthMock.mockReturnValue({ role: 'account' });
    useTenantMock.mockReturnValue({
      options: [],
      activeGrandClient: null,
      setActiveGrandClient: vi.fn(),
      isLoading: false,
    });

    const { container } = render(<TenantPicker />);
    expect(container).toBeEmptyDOMElement();
  });
});
