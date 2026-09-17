import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { useTenant } from '@/providers/TenantProvider';
import {
  fetchRules, fetchRuleDetail, ratifyRule, activateRule, deprecateRule, quarantineRule,
  fetchContractVersions, fetchContractRates, createContractRate, updateContractRate, deleteContractRate,
  type RuleRow, type RuleDetail, type RuleListSortKey, type RuleTier, type RuleKind, type RuleLifecycle,
  type ContractVersionOption, type ContractRateRow,
} from '@/lib/api';

const PAGE_SIZE = 10;

/**
 * 86e3a6rg1: which lifecycle transitions are valid from a given status
 * (transition-rule-lifecycle.ts's own ALLOWED map) -- drives which action
 * buttons the detail drawer offers, so a user is never shown a transition
 * the backend would reject.
 */
const RULE_ACTIONS: Record<RuleLifecycle, { label: string; run: typeof ratifyRule }[]> = {
  PROPOSED: [
    { label: 'Move to Shadow', run: ratifyRule },
    { label: 'Quarantine', run: quarantineRule },
  ],
  SHADOW: [
    { label: 'Activate', run: activateRule },
    { label: 'Quarantine', run: quarantineRule },
  ],
  ACTIVE: [
    { label: 'Deprecate', run: deprecateRule },
    { label: 'Quarantine', run: quarantineRule },
  ],
  QUARANTINED: [{ label: 'Move to Shadow', run: ratifyRule }],
  DEPRECATED: [],
};

const STATUS_BADGE_VARIANT: Record<RuleLifecycle, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PROPOSED: 'outline',
  SHADOW: 'secondary',
  ACTIVE: 'default',
  DEPRECATED: 'secondary',
  QUARANTINED: 'destructive',
};

function RuleDetailSheet({
  ruleVersionId,
  onOpenChange,
  onChanged,
}: {
  ruleVersionId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RuleDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [rationale, setRationale] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!ruleVersionId) {
      setDetail(null);
      return;
    }
    setIsLoading(true);
    setRationale('');
    fetchRuleDetail(ruleVersionId).then((d) => {
      setDetail(d);
      setIsLoading(false);
    });
  }, [ruleVersionId]);

  async function runAction(run: typeof ratifyRule) {
    if (!detail) return;
    if (!rationale.trim()) {
      toast.error('A rationale is required for a rule lifecycle transition.');
      return;
    }
    setIsSubmitting(true);
    const result = await run(detail.ruleVersionId, rationale);
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Rule transitioned.');
    onOpenChange(false);
    onChanged();
  }

  return (
    <Sheet open={ruleVersionId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{detail?.slug ?? (isLoading ? 'Loading…' : 'Rule')}</SheetTitle>
          <SheetDescription>{detail ? `${detail.ruleType} · ${detail.hardness}` : ''}</SheetDescription>
        </SheetHeader>
        {detail && (
          <div className="flex flex-col gap-4 px-4 pb-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant={STATUS_BADGE_VARIANT[detail.status]}>{detail.status}</Badge>
              {detail.tier && <Badge variant="outline">{detail.tier}</Badge>}
              {detail.kind && <Badge variant="outline">{detail.kind}</Badge>}
              <Badge variant="outline">{detail.emits}</Badge>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-medium">Predicate tree</h3>
              <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs">
                {JSON.stringify(detail.ast, null, 2)}
              </pre>
            </div>

            {detail.history.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Lifecycle history</h3>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {detail.history.map((h) => (
                    <li key={h.id}>
                      {h.fromLifecycle ?? '—'} → {h.toLifecycle} ({new Date(h.recordedAt).toLocaleString()})
                      {h.rationale ? `: ${h.rationale}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {RULE_ACTIONS[detail.status].length > 0 && (
              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <Label htmlFor="rule-rationale">Rationale (required to transition)</Label>
                <Textarea
                  id="rule-rationale"
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  placeholder="Why is this transition happening?"
                />
                <div className="flex flex-wrap gap-2">
                  {RULE_ACTIONS[detail.status].map((action) => (
                    <Button key={action.label} size="sm" disabled={isSubmitting} onClick={() => runAction(action.run)}>
                      {action.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RulesTab() {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState<RuleTier | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<RuleKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<RuleLifecycle | 'all'>('all');
  const [sort, setSort] = useState<{ key: RuleListSortKey; direction: 'asc' | 'desc' }>({ key: 'lastModified', direction: 'desc' });
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    const result = await fetchRules({
      tier: tierFilter === 'all' ? undefined : tierFilter,
      kind: kindFilter === 'all' ? undefined : kindFilter,
      status: statusFilter === 'all' ? undefined : statusFilter,
      sortKey: sort.key,
      sortDirection: sort.direction,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    setRows(result.rows);
    setTotal(result.total);
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, [tierFilter, kindFilter, statusFilter, sort, page]);

  function toggleSort(key: RuleListSortKey) {
    setPage(0);
    setSort((prev) => {
      if (prev.key !== key) return { key, direction: 'asc' };
      return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
    });
  }

  function sortIcon(key: RuleListSortKey) {
    if (sort.key !== key) return <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />;
    return sort.direction === 'asc' ? <ArrowUp className="size-3.5" aria-hidden="true" /> : <ArrowDown className="size-3.5" aria-hidden="true" />;
  }

  const columns: { key: RuleListSortKey; header: string }[] = [
    { key: 'name', header: 'Name' },
    { key: 'tier', header: 'Tier' },
    { key: 'type', header: 'Type' },
    { key: 'status', header: 'Status' },
    { key: 'lastModified', header: 'Last modified' },
  ];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by tier"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={tierFilter}
          onChange={(e) => {
            setPage(0);
            setTierFilter(e.target.value as RuleTier | 'all');
          }}
        >
          <option value="all">All tiers</option>
          <option value="STANDARD">Standard</option>
          <option value="CLIENT">Client</option>
          <option value="CONTRACT">Contract</option>
        </select>

        <select
          aria-label="Filter by type"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={kindFilter}
          onChange={(e) => {
            setPage(0);
            setKindFilter(e.target.value as RuleKind | 'all');
          }}
        >
          <option value="all">All types</option>
          <option value="GATING">Gating</option>
          <option value="SCORING">Scoring</option>
        </select>

        <select
          aria-label="Filter by status"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={statusFilter}
          onChange={(e) => {
            setPage(0);
            setStatusFilter(e.target.value as RuleLifecycle | 'all');
          }}
        >
          <option value="all">All statuses</option>
          <option value="PROPOSED">Proposed</option>
          <option value="SHADOW">Shadow</option>
          <option value="ACTIVE">Active</option>
          <option value="DEPRECATED">Deprecated</option>
          <option value="QUARANTINED">Quarantined</option>
        </select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key}>
                <button type="button" onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 font-medium">
                  {c.header}
                  {sortIcon(c.key)}
                </button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-sm text-muted-foreground">Loading…</TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-sm text-muted-foreground">No rules match these filters.</TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.ruleVersionId} className="cursor-pointer" onClick={() => setOpenRuleId(r.ruleVersionId)}>
                <TableCell className="font-medium">{r.slug}</TableCell>
                <TableCell>{r.tier ?? '—'}</TableCell>
                <TableCell>{r.kind ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE_VARIANT[r.status]}>{r.status}</Badge>
                </TableCell>
                <TableCell>{new Date(r.lastModified).toLocaleDateString()}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page + 1} of {pageCount} ({total} total)
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>
              Next
            </Button>
          </div>
        </div>
      )}

      <RuleDetailSheet ruleVersionId={openRuleId} onOpenChange={(open) => !open && setOpenRuleId(null)} onChanged={load} />
    </div>
  );
}

function CreateRateDialog({
  tenantId,
  contractVersions,
  onCreated,
}: {
  tenantId: string;
  contractVersions: ContractVersionOption[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [contractVersionId, setContractVersionId] = useState('');
  const [category, setCategory] = useState('LINEHAUL');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function reset() {
    setContractVersionId('');
    setCategory('LINEHAUL');
    setAmount('');
    setCurrency('USD');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!contractVersionId) {
      toast.error('Select a contract version.');
      return;
    }
    setIsSubmitting(true);
    const result = await createContractRate(tenantId, { contractVersionId, category, amount, currency });
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Rate created.');
    reset();
    setOpen(false);
    onCreated();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button onClick={() => setOpen(true)}>Create rate</Button>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create rate</DialogTitle>
            <DialogDescription>Adds a flat contract rate for one (contract version, charge category) pair.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate-contract-version">Contract version</Label>
              <select
                id="rate-contract-version"
                required
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={contractVersionId}
                onChange={(e) => setContractVersionId(e.target.value)}
              >
                <option value="">Select a contract version…</option>
                {contractVersions.map((cv) => (
                  <option key={cv.contractVersionId} value={cv.contractVersionId}>
                    {cv.contractName} ({cv.versionLabel ?? cv.contractVersionId.slice(0, 8)})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate-category">Category</Label>
              <Input id="rate-category" required value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate-amount">Amount</Label>
              <Input id="rate-amount" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 900.0000" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate-currency">Currency</Label>
              <Input id="rate-currency" required value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRateDialog({
  tenantId,
  rate,
  onOpenChange,
  onSaved,
}: {
  tenantId: string;
  rate: ContractRateRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setAmount(rate?.amount ?? '');
  }, [rate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rate) return;
    setIsSubmitting(true);
    const result = await updateContractRate(tenantId, rate.id, { amount });
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Rate updated.');
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={rate !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit rate</DialogTitle>
            <DialogDescription>{rate ? `${rate.contractName} · ${rate.category}` : ''}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-rate-amount">Amount</Label>
              <Input id="edit-rate-amount" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RatesTab() {
  const { activeClient } = useTenant();
  const [rates, setRates] = useState<ContractRateRow[]>([]);
  const [contractVersions, setContractVersions] = useState<ContractVersionOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<ContractRateRow | null>(null);

  async function load(tenantId: string) {
    setIsLoading(true);
    const [rateRows, versionRows] = await Promise.all([fetchContractRates(tenantId), fetchContractVersions(tenantId)]);
    setRates(rateRows);
    setContractVersions(versionRows);
    setIsLoading(false);
  }

  useEffect(() => {
    if (activeClient) load(activeClient.id);
  }, [activeClient?.id]);

  async function handleDelete(rate: ContractRateRow) {
    if (!activeClient) return;
    const ok = await deleteContractRate(activeClient.id, rate.id);
    if (!ok) {
      toast.error('Could not delete this rate.');
      return;
    }
    toast.success('Rate deleted.');
    setRates((prev) => prev.filter((r) => r.id !== rate.id));
  }

  if (!activeClient) {
    return <p className="text-sm text-muted-foreground">Select a client from the tenant picker to view its rates.</p>;
  }

  const columns: DataTableColumn<ContractRateRow>[] = [
    { key: 'contract', header: 'Contract', sortValue: (r) => r.contractName, render: (r) => `${r.contractName} (${r.versionLabel ?? '—'})` },
    { key: 'category', header: 'Category', sortValue: (r) => r.category, render: (r) => r.category },
    { key: 'amount', header: 'Amount', sortValue: (r) => Number(r.amount), render: (r) => `${r.amount} ${r.currency}` },
    { key: 'clause', header: 'Citation', render: (r) => (r.clauseId ? 'Linked' : '—') },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={() => handleDelete(r)}>Delete</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DataTable
        rows={rates}
        columns={columns}
        getRowId={(r) => r.id}
        searchPlaceholder="Search by category…"
        searchPredicate={(r, q) => r.category.toLowerCase().includes(q.toLowerCase()) || r.contractName.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<CreateRateDialog tenantId={activeClient.id} contractVersions={contractVersions} onCreated={() => load(activeClient.id)} />}
        isLoading={isLoading}
        emptyState="No rates yet for this tenant."
      />
      <EditRateDialog
        tenantId={activeClient.id}
        rate={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => load(activeClient.id)}
      />
    </div>
  );
}

export default function RulesRatesPage() {
  const [tab, setTab] = useState<'rules' | 'rates'>('rules');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Rules & Rates</h1>
      </div>

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

      {tab === 'rules' ? <RulesTab /> : <RatesTab />}
    </div>
  );
}
