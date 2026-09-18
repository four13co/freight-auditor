import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { ClientSelector } from '@/components/ClientSelector';
import { useScopedEntities, useScopedUsers, type ScopedUser } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

function VendorUserFormDialog({
  open,
  onOpenChange,
  vendorOptions,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendorOptions: { id: string; name: string }[];
  initial?: { name: string; email: string; vendorId?: string };
  onSubmit: (name: string, email: string, vendorId: string, vendorName: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? '');

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setEmail(initial?.email ?? '');
      setVendorId(initial?.vendorId ?? '');
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const vendor = vendorOptions.find((v) => v.id === vendorId);
            if (!vendor) return;
            onSubmit(name, email, vendor.id, vendor.name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial ? 'Edit vendor user' : 'Invite vendor user'}</DialogTitle>
            <DialogDescription>
              In-memory for now — see this PR&apos;s Uncertainties for why there&apos;s no backend yet.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-user-name">Name</Label>
              <Input id="vendor-user-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-user-email">Email</Label>
              <Input
                id="vendor-user-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-user-vendor">Vendor</Label>
              <select
                id="vendor-user-vendor"
                required
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
              >
                <option value="">Select a vendor…</option>
                {vendorOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={vendorOptions.length === 0}>
              {initial ? 'Save' : 'Invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 86e3a6rhj: vendor users this account manages on behalf of a selected
 * Client's vendors. Same shared-store approach as ClientUsersPage
 * (86e3a6rh4): no backend concept exists, so this routes through
 * ScopedUser, scoped by `vendorUsers:<clientId>`. The vendor picker itself
 * reads the real Vendor entities already created under `client:<clientId>`
 * (Employee's VendorsPage / this epic's eventual Client Vendors screen both
 * write into that same scope) rather than a separate vendor list.
 */
export default function VendorUsersPage() {
  const { activeGrandClient } = useTenant();
  const vendorScopeKey = activeGrandClient ? `client:${activeGrandClient.id}` : null;
  const { entities: vendors } = useScopedEntities(vendorScopeKey);
  const userScopeKey = activeGrandClient ? `vendorUsers:${activeGrandClient.id}` : null;
  const { users, create, update, toggleStatus, remove } = useScopedUsers(userScopeKey);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedUser | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string>('all');

  const vendorOptions = useMemo(() => vendors.map((v) => ({ id: v.id, name: v.name })), [vendors]);

  const filtered = useMemo(() => {
    if (vendorFilter === 'all') return users;
    return users.filter((u) => u.vendorId === vendorFilter);
  }, [users, vendorFilter]);

  const columns: DataTableColumn<ScopedUser>[] = [
    { key: 'name', header: 'Name', sortValue: (u) => u.name, render: (u) => u.name },
    { key: 'email', header: 'Email', sortValue: (u) => u.email, render: (u) => u.email },
    { key: 'vendor', header: 'Vendor', sortValue: (u) => u.vendorName ?? '', render: (u) => u.vendorName ?? '—' },
    { key: 'grandClient', header: 'Client', render: () => activeGrandClient?.name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      sortValue: (u) => (u.status === 'active' ? 0 : 1),
      render: (u) => <Badge variant={u.status === 'active' ? 'default' : 'secondary'}>{u.status === 'active' ? 'Active' : 'Disabled'}</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (u) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggleStatus(u.id)}>
            {u.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => remove(u.id)}>
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Users (Vendor)</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ClientSelector />
        {activeGrandClient && (
          <select
            aria-label="Filter by vendor"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
          >
            <option value="all">All vendors</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!activeGrandClient ? (
        <p className="text-sm text-muted-foreground">Select a Client to view its vendor users.</p>
      ) : (
        <>
          <DataTable
            rows={filtered}
            columns={columns}
            getRowId={(u) => u.id}
            searchPlaceholder="Search vendor users…"
            searchPredicate={(u, q) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase())}
            toolbarEnd={
              <Button onClick={() => setCreateOpen(true)} disabled={vendorOptions.length === 0}>
                Invite vendor user
              </Button>
            }
            emptyState={
              vendorOptions.length === 0
                ? `No vendors yet for ${activeGrandClient.name} — add one before inviting vendor users.`
                : `No vendor users yet for ${activeGrandClient.name}.`
            }
          />

          <VendorUserFormDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            vendorOptions={vendorOptions}
            onSubmit={(name, email, vendorId, vendorName) => {
              create({ name, email, role: 'vendor', vendorId, vendorName });
              setCreateOpen(false);
            }}
          />

          <VendorUserFormDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            vendorOptions={vendorOptions}
            initial={editing ? { name: editing.name, email: editing.email, vendorId: editing.vendorId } : undefined}
            onSubmit={(name, email, vendorId, vendorName) => {
              if (!editing) return;
              update(editing.id, { name, email, vendorId, vendorName });
              setEditing(null);
            }}
          />
        </>
      )}
    </div>
  );
}
