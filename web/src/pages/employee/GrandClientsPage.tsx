import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { countScopedEntities, useScopedEntities, type ScopedEntity } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

/**
 * "Grand Client" naming may change (86e3a6ren's own note) -- kept behind
 * this one constant so a future rename touches one line.
 */
const GRAND_CLIENT_LABEL = 'Grand Client';

function GrandClientFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { name: string };
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');

  useEffect(() => {
    if (open) setName(initial?.name ?? '');
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial ? `Edit ${GRAND_CLIENT_LABEL}` : `Create ${GRAND_CLIENT_LABEL}`}</DialogTitle>
            <DialogDescription>
              In-memory for now — see this PR&apos;s Uncertainties for why there&apos;s no backend yet.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="grand-client-name">Name</Label>
              <Input id="grand-client-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">{initial ? 'Save' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function GrandClientsPage() {
  const navigate = useNavigate();
  const { activeClient, setActiveGrandClient } = useTenant();
  const scopeKey = activeClient ? `client:${activeClient.id}` : null;
  const { entities, create, update, toggleStatus } = useScopedEntities(scopeKey);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedEntity | null>(null);

  function goToVendors(entity: ScopedEntity) {
    setActiveGrandClient({ id: entity.id, name: entity.name });
    navigate('/employee/accounts/grand-clients/vendors');
  }

  const columns: DataTableColumn<ScopedEntity>[] = [
    {
      key: 'name',
      header: `${GRAND_CLIENT_LABEL} name`,
      sortValue: (e) => e.name,
      render: (e) => (
        <button type="button" className="font-medium hover:underline" onClick={() => goToVendors(e)}>
          {e.name}
        </button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (e) => (e.status === 'active' ? 0 : 1),
      render: (e) => <Badge variant={e.status === 'active' ? 'default' : 'secondary'}>{e.status === 'active' ? 'Active' : 'Disabled'}</Badge>,
    },
    {
      key: 'vendors',
      header: 'Vendor count',
      sortValue: (e) => countScopedEntities(`grandClient:${e.id}`),
      render: (e) => countScopedEntities(`grandClient:${e.id}`),
    },
    {
      key: 'created',
      header: 'Created date',
      sortValue: (e) => e.createdAt,
      render: (e) => new Date(e.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (e) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(e)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => goToVendors(e)}>
            View Vendors
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggleStatus(e.id)}>
            {e.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
        </div>
      ),
    },
  ];

  if (!activeClient) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{GRAND_CLIENT_LABEL}s</h1>
        <p className="text-sm text-muted-foreground">
          Select a client from the Clients page (or the tenant picker) to view its {GRAND_CLIENT_LABEL.toLowerCase()}s.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          {GRAND_CLIENT_LABEL}s for {activeClient.name}
        </h1>
      </div>

      <DataTable
        rows={entities}
        columns={columns}
        getRowId={(e) => e.id}
        searchPlaceholder={`Search ${GRAND_CLIENT_LABEL.toLowerCase()}s…`}
        searchPredicate={(e, q) => e.name.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<Button onClick={() => setCreateOpen(true)}>Create {GRAND_CLIENT_LABEL}</Button>}
        emptyState={`No ${GRAND_CLIENT_LABEL.toLowerCase()}s yet for ${activeClient.name}.`}
      />

      <GrandClientFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(name) => {
          create({ name });
          setCreateOpen(false);
        }}
      />

      <GrandClientFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        initial={editing ? { name: editing.name } : undefined}
        onSubmit={(name) => {
          if (!editing) return;
          update(editing.id, { name });
          setEditing(null);
        }}
      />
    </div>
  );
}
