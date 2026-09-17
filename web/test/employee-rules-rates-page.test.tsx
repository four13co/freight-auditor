import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import RulesRatesPage from '@/pages/employee/RulesRatesPage';

const fetchRulesMock = vi.fn();
const fetchRuleDetailMock = vi.fn();
const ratifyRuleMock = vi.fn();
const activateRuleMock = vi.fn();
const deprecateRuleMock = vi.fn();
const quarantineRuleMock = vi.fn();
const fetchContractVersionsMock = vi.fn();
const fetchContractRatesMock = vi.fn();
const createContractRateMock = vi.fn();
const updateContractRateMock = vi.fn();
const deleteContractRateMock = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchRules: (...args: unknown[]) => fetchRulesMock(...args),
    fetchRuleDetail: (...args: unknown[]) => fetchRuleDetailMock(...args),
    ratifyRule: (...args: unknown[]) => ratifyRuleMock(...args),
    activateRule: (...args: unknown[]) => activateRuleMock(...args),
    deprecateRule: (...args: unknown[]) => deprecateRuleMock(...args),
    quarantineRule: (...args: unknown[]) => quarantineRuleMock(...args),
    fetchContractVersions: (...args: unknown[]) => fetchContractVersionsMock(...args),
    fetchContractRates: (...args: unknown[]) => fetchContractRatesMock(...args),
    createContractRate: (...args: unknown[]) => createContractRateMock(...args),
    updateContractRate: (...args: unknown[]) => updateContractRateMock(...args),
    deleteContractRate: (...args: unknown[]) => deleteContractRateMock(...args),
  };
});

let activeClient: { id: string; name: string } | null = { id: 't1', name: 'Acme Freight' };
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeClient, setActiveClient: vi.fn(), setActiveGrandClient: vi.fn(), options: [], isLoading: false, activeGrandClient: null }),
}));

const RULES = [
  { ruleVersionId: 'rv-1', ruleId: 'r-1', slug: 'high-value-linehaul', ruleType: 'STRUCTURAL', tier: 'STANDARD' as const, kind: 'GATING' as const, status: 'ACTIVE' as const, hardness: 'FIRM_RULE', lastModified: '2026-02-01T00:00:00Z' },
  { ruleVersionId: 'rv-2', ruleId: 'r-2', slug: 'discount-eligibility', ruleType: 'INTRA_LINE', tier: 'CLIENT' as const, kind: 'SCORING' as const, status: 'PROPOSED' as const, hardness: 'HUMAN_INPUT', lastModified: '2026-02-05T00:00:00Z' },
];

const RATES = [
  { id: 'rate-1', contractVersionId: 'cv-1', contractId: 'c-1', contractName: 'Acme MSA', versionLabel: 'v1', category: 'LINEHAUL', amount: '900.0000', currency: 'USD', clauseId: null, createdAt: '2026-01-01T00:00:00Z' },
];

const CONTRACT_VERSIONS = [
  { contractVersionId: 'cv-1', contractId: 'c-1', contractName: 'Acme MSA', versionLabel: 'v1', validFrom: '2026-01-01', validTo: null },
];

beforeEach(() => {
  activeClient = { id: 't1', name: 'Acme Freight' };
  fetchRulesMock.mockReset().mockResolvedValue({ rows: RULES, total: RULES.length });
  fetchRuleDetailMock.mockReset().mockResolvedValue(null);
  ratifyRuleMock.mockReset().mockResolvedValue({ ok: true });
  activateRuleMock.mockReset().mockResolvedValue({ ok: true });
  deprecateRuleMock.mockReset().mockResolvedValue({ ok: true });
  quarantineRuleMock.mockReset().mockResolvedValue({ ok: true });
  fetchContractVersionsMock.mockReset().mockResolvedValue(CONTRACT_VERSIONS);
  fetchContractRatesMock.mockReset().mockResolvedValue(RATES);
  createContractRateMock.mockReset().mockResolvedValue({ ok: true });
  updateContractRateMock.mockReset().mockResolvedValue({ ok: true });
  deleteContractRateMock.mockReset().mockResolvedValue(true);
});

describe('RulesRatesPage', () => {
  it('AC: Rules tab loads with the table showing tier/type/status columns', async () => {
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());
    expect(screen.getByText('discount-eligibility')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('STANDARD')).toBeInTheDocument();
    expect(within(table).getByText('GATING')).toBeInTheDocument();
  });

  it('AC: filters call the server with the selected tier/kind/status', async () => {
    const user = userEvent.setup();
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Filter by tier'), 'CLIENT');
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'CLIENT' })));

    await user.selectOptions(screen.getByLabelText('Filter by type'), 'SCORING');
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'SCORING' })));

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'PROPOSED');
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'PROPOSED' })));
  });

  it('AC: sorting toggles server-side sortKey/sortDirection', async () => {
    const user = userEvent.setup();
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Tier/ }));
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ sortKey: 'tier', sortDirection: 'asc' })));

    await user.click(screen.getByRole('button', { name: /Tier/ }));
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ sortKey: 'tier', sortDirection: 'desc' })));
  });

  it('AC: pagination requests the next page from the server', async () => {
    const user = userEvent.setup();
    fetchRulesMock.mockResolvedValue({ rows: RULES, total: 25 });
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(fetchRulesMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 })));
  });

  it('AC: row click opens the detail drawer showing the predicate tree, and transitions the rule', async () => {
    const user = userEvent.setup();
    fetchRuleDetailMock.mockResolvedValue({
      ruleVersionId: 'rv-1', ruleId: 'r-1', slug: 'high-value-linehaul', ruleType: 'STRUCTURAL',
      tier: 'STANDARD', kind: 'GATING', status: 'ACTIVE', hardness: 'FIRM_RULE', emits: 'PASS_FAIL',
      ast: { op: 'GTE', field: 'amount', value: 100 }, expectedInputs: ['amount'], provenance: {},
      clauseId: null, validFrom: '2026-01-01', validTo: null, recordedAt: '2026-02-01T00:00:00Z',
      lastModified: '2026-02-01T00:00:00Z', history: [],
    });
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());

    await user.click(screen.getByText('high-value-linehaul'));
    await waitFor(() => expect(screen.getByText(/"op": "GTE"/)).toBeInTheDocument());

    await user.type(screen.getByLabelText('Rationale (required to transition)'), 'no longer needed');
    await user.click(screen.getByRole('button', { name: 'Deprecate' }));

    await waitFor(() => expect(deprecateRuleMock).toHaveBeenCalledWith('rv-1', 'no longer needed'));
  });

  it('AC: transition requires a rationale', async () => {
    const user = userEvent.setup();
    fetchRuleDetailMock.mockResolvedValue({
      ruleVersionId: 'rv-1', ruleId: 'r-1', slug: 'high-value-linehaul', ruleType: 'STRUCTURAL',
      tier: 'STANDARD', kind: 'GATING', status: 'ACTIVE', hardness: 'FIRM_RULE', emits: 'PASS_FAIL',
      ast: {}, expectedInputs: [], provenance: {}, clauseId: null, validFrom: '2026-01-01', validTo: null,
      recordedAt: '2026-02-01T00:00:00Z', lastModified: '2026-02-01T00:00:00Z', history: [],
    });
    render(<RulesRatesPage />);
    await waitFor(() => expect(screen.getByText('high-value-linehaul')).toBeInTheDocument());
    await user.click(screen.getByText('high-value-linehaul'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deprecate' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Deprecate' }));
    expect(deprecateRuleMock).not.toHaveBeenCalled();
  });

  it('AC: Rates tab prompts for a tenant when none is active', async () => {
    activeClient = null;
    const user = userEvent.setup();
    render(<RulesRatesPage />);
    await user.click(screen.getByRole('tab', { name: 'Rates' }));
    expect(screen.getByText('Select a client from the tenant picker to view its rates.')).toBeInTheDocument();
  });

  it('AC: Rates tab loads and supports create/edit/delete CRUD', async () => {
    const user = userEvent.setup();
    render(<RulesRatesPage />);
    await user.click(screen.getByRole('tab', { name: 'Rates' }));
    await waitFor(() => expect(screen.getByText('LINEHAUL')).toBeInTheDocument());

    // create
    await user.click(screen.getByRole('button', { name: 'Create rate' }));
    await user.selectOptions(screen.getByLabelText('Contract version'), 'cv-1');
    await user.clear(screen.getByLabelText('Category'));
    await user.type(screen.getByLabelText('Category'), 'FUEL');
    await user.type(screen.getByLabelText('Amount'), '10.0000');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createContractRateMock).toHaveBeenCalledWith('t1', {
      contractVersionId: 'cv-1', category: 'FUEL', amount: '10.0000', currency: 'USD',
    }));

    // edit
    const row = screen.getByText('LINEHAUL').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
    await user.clear(amountInput);
    await user.type(amountInput, '950.0000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateContractRateMock).toHaveBeenCalledWith('t1', 'rate-1', { amount: '950.0000' }));

    // delete
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteContractRateMock).toHaveBeenCalledWith('t1', 'rate-1'));
  });
});
