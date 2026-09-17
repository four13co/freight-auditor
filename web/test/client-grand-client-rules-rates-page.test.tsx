import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import GrandClientRulesRatesPage from '@/pages/client/GrandClientRulesRatesPage';
import { useScopedRates, useScopedRules } from '@/lib/in-memory-hierarchy-store';

let nextId = 0;
function freshGrandClient() {
  nextId += 1;
  return { id: `gc-rules-rates-${nextId}`, name: `Grand Client ${nextId}` };
}

function seedRule(grandClientId: string, input: { name: string; tier: 'STANDARD' | 'CLIENT' | 'CONTRACT'; kind: 'GATING' | 'SCORING' }) {
  const { result } = renderHook(() => useScopedRules(`grandClientRules:${grandClientId}`));
  act(() => result.current.create(input));
}

function seedRate(grandClientId: string, input: { category: string; amount: string; currency: string }) {
  const { result } = renderHook(() => useScopedRates(`grandClientRates:${grandClientId}`));
  act(() => result.current.create(input));
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient, setActiveGrandClient: () => {} }),
}));

describe('GrandClientRulesRatesPage', () => {
  it('AC: prompts to select a Grand Client when none is active', () => {
    activeGrandClient = null;
    render(<GrandClientRulesRatesPage />);
    expect(screen.getByText('Select a Grand Client to view its rules and rates.')).toBeInTheDocument();
  });

  it('AC: graceful empty state when no rules/rates are configured yet', () => {
    activeGrandClient = freshGrandClient();
    render(<GrandClientRulesRatesPage />);
    expect(screen.getByText('No rules configured yet for this Grand Client.')).toBeInTheDocument();
  });

  it('AC: rules table loads for the selected Grand Client', () => {
    activeGrandClient = freshGrandClient();
    seedRule(activeGrandClient.id, { name: 'Weight tolerance', tier: 'CLIENT', kind: 'GATING' });
    render(<GrandClientRulesRatesPage />);

    expect(screen.getByText('Weight tolerance')).toBeInTheDocument();
    expect(screen.getByText('CLIENT')).toBeInTheDocument();
  });

  it('AC: rates table loads for the selected Grand Client (Rates tab)', async () => {
    activeGrandClient = freshGrandClient();
    seedRate(activeGrandClient.id, { category: 'LINEHAUL', amount: '125.00', currency: 'USD' });
    const user = userEvent.setup();
    render(<GrandClientRulesRatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Rates' }));

    expect(screen.getByText('LINEHAUL')).toBeInTheDocument();
    expect(screen.getByText('125.00')).toBeInTheDocument();
  });

  it("AC: data is scoped to the selected Grand Client only", () => {
    const gcA = freshGrandClient();
    const gcB = freshGrandClient();
    seedRule(gcA.id, { name: 'Only under A', tier: 'STANDARD', kind: 'SCORING' });

    activeGrandClient = gcB;
    render(<GrandClientRulesRatesPage />);

    expect(screen.queryByText('Only under A')).not.toBeInTheDocument();
    expect(screen.getByText('No rules configured yet for this Grand Client.')).toBeInTheDocument();
  });
});
