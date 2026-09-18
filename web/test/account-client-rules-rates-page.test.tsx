import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ClientRulesRatesPage from '@/pages/account/ClientRulesRatesPage';
import { useScopedRates, useScopedRules } from '@/lib/in-memory-hierarchy-store';

let nextId = 0;
function freshClient() {
  nextId += 1;
  return { id: `gc-rules-rates-${nextId}`, name: `Client ${nextId}` };
}

function seedRule(clientId: string, input: { name: string; tier: 'STANDARD' | 'CLIENT' | 'CONTRACT'; kind: 'GATING' | 'SCORING' }) {
  const { result } = renderHook(() => useScopedRules(`clientRules:${clientId}`));
  act(() => result.current.create(input));
}

function seedRate(clientId: string, input: { category: string; amount: string; currency: string }) {
  const { result } = renderHook(() => useScopedRates(`clientRates:${clientId}`));
  act(() => result.current.create(input));
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient, setActiveGrandClient: () => {} }),
}));

describe('ClientRulesRatesPage', () => {
  it('AC: prompts to select a Client when none is active', () => {
    activeGrandClient = null;
    render(<ClientRulesRatesPage />);
    expect(screen.getByText('Select a Client to view its rules and rates.')).toBeInTheDocument();
  });

  it('AC: graceful empty state when no rules/rates are configured yet', () => {
    activeGrandClient = freshClient();
    render(<ClientRulesRatesPage />);
    expect(screen.getByText('No rules configured yet for this Client.')).toBeInTheDocument();
  });

  it('AC: rules table loads for the selected Client', () => {
    activeGrandClient = freshClient();
    seedRule(activeGrandClient.id, { name: 'Weight tolerance', tier: 'CLIENT', kind: 'GATING' });
    render(<ClientRulesRatesPage />);

    expect(screen.getByText('Weight tolerance')).toBeInTheDocument();
    expect(screen.getByText('CLIENT')).toBeInTheDocument();
  });

  it('AC: rates table loads for the selected Client (Rates tab)', async () => {
    activeGrandClient = freshClient();
    seedRate(activeGrandClient.id, { category: 'LINEHAUL', amount: '125.00', currency: 'USD' });
    const user = userEvent.setup();
    render(<ClientRulesRatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Rates' }));

    expect(screen.getByText('LINEHAUL')).toBeInTheDocument();
    expect(screen.getByText('125.00')).toBeInTheDocument();
  });

  it("AC: data is scoped to the selected Client only", () => {
    const clientA = freshClient();
    const clientB = freshClient();
    seedRule(clientA.id, { name: 'Only under A', tier: 'STANDARD', kind: 'SCORING' });

    activeGrandClient = clientB;
    render(<ClientRulesRatesPage />);

    expect(screen.queryByText('Only under A')).not.toBeInTheDocument();
    expect(screen.getByText('No rules configured yet for this Client.')).toBeInTheDocument();
  });
});
