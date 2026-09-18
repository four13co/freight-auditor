import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { GrandClientSelector } from '@/components/GrandClientSelector';
import { useScopedRates, useScopedRules, type ScopedRate, type ScopedRule } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

function RulesTab({ grandClientId }: { grandClientId: string }) {
  const { rules } = useScopedRules(`grandClientRules:${grandClientId}`);

  const columns: DataTableColumn<ScopedRule>[] = [
    { key: 'name', header: 'Name', sortValue: (r) => r.name, render: (r) => r.name },
    { key: 'tier', header: 'Tier', sortValue: (r) => r.tier, render: (r) => r.tier },
    { key: 'kind', header: 'Type', sortValue: (r) => r.kind, render: (r) => r.kind },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <Badge variant="secondary">{r.status}</Badge> },
  ];

  return (
    <DataTable
      rows={rules}
      columns={columns}
      getRowId={(r) => r.id}
      searchPlaceholder="Search rules…"
      searchPredicate={(r, q) => r.name.toLowerCase().includes(q.toLowerCase())}
      emptyState="No rules configured yet for this Grand Client."
    />
  );
}

function RatesTab({ grandClientId }: { grandClientId: string }) {
  const { rates } = useScopedRates(`grandClientRates:${grandClientId}`);

  const columns: DataTableColumn<ScopedRate>[] = [
    { key: 'category', header: 'Category', sortValue: (r) => r.category, render: (r) => r.category },
    { key: 'amount', header: 'Amount', sortValue: (r) => r.amount, render: (r) => r.amount },
    { key: 'currency', header: 'Currency', sortValue: (r) => r.currency, render: (r) => r.currency },
  ];

  return (
    <DataTable
      rows={rates}
      columns={columns}
      getRowId={(r) => r.id}
      searchPlaceholder="Search rates…"
      searchPredicate={(r, q) => r.category.toLowerCase().includes(q.toLowerCase())}
      emptyState="No rates configured yet for this Grand Client."
    />
  );
}

/**
 * 86e3a6rjr: a read-only, Grand-Client-scoped view of rules and rates
 * (task's own AC: "Default to read-only... add edit as backend supports
 * it"). Neither `/api/rules` (global, internal-analyst-only per PR #407's
 * Uncertainties) nor `/api/internal/tenants/:id/rates` (real-tenant-scoped,
 * also internal-only -- registerTenantAdminAuthPreHandler) has anything to
 * fetch for a Grand Client, which isn't a real tenant at all -- same gap as
 * every other Grand-Client-scoped screen in this epic, so this routes
 * through the shared in-memory-hierarchy-store's new ScopedRule/ScopedRate
 * (Bridge decision on 86e3a6r3b: one shared store, no per-screen mocks).
 */
export default function GrandClientRulesRatesPage() {
  const { activeGrandClient } = useTenant();
  const [tab, setTab] = useState<'rules' | 'rates'>('rules');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Grand Client Rules & Rates</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <GrandClientSelector />
      </div>

      {!activeGrandClient ? (
        <p className="text-sm text-muted-foreground">Select a Grand Client to view its rules and rates.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Rules & Rates sections" className="flex w-fit gap-1 rounded-lg border border-border bg-muted/40 p-1">
            <Button
              type="button"
              role="tab"
              aria-selected={tab === 'rules'}
              variant={tab === 'rules' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setTab('rules')}
            >
              Rules
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={tab === 'rates'}
              variant={tab === 'rates' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setTab('rates')}
            >
              Rates
            </Button>
          </div>

          {tab === 'rules' ? <RulesTab grandClientId={activeGrandClient.id} /> : <RatesTab grandClientId={activeGrandClient.id} />}
        </>
      )}
    </div>
  );
}
