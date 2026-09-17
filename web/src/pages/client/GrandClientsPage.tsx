import { useEffect, useState } from 'react';
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
import { getOwnClientId } from '@/lib/api';

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
            <DialogTitle>{initial ? 'Edit Grand Client' : 'Create Grand Client'}</DialogTitle>
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

/**
 * 86e3a6rhv: this client's own Grand Client entities. Mirrors Employee's
 * GrandClientsPage (86e3a6ren) but without the Client parent level (this
 * page's own scope IS the client, implicitly -- no client-picker needed).
 * Same shared in-memory-hierarchy-store scope key, `client:<id>`, as
 * Employee's page writes into -- Employee managing this client's Grand
 * Clients on their behalf and this client managing their own see the exact
 * same list, by construction of the one-shared-store decision.
 *
 * No "View Vendors" row action here (unlike Employee's GrandClientsPage):
 * the Client nav has no Vendors *entity* page (only a Vendor *users* page,
 * 86e3a6rhj, which reads Vendor entities Employee's flow creates under this
 * same `grandClient:<id>` scope) -- see this PR's Uncertainties.
 */
export default function GrandClientsPage() {
  const ownClientId = getOwnClientId();
  const scopeKey = ownClientId ? `client:${ownClientId}` : null;
  const { entities, create, update, toggleStatus } = useScopedEntities(scopeKey);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedEntity | null>(null);

  const columns: DataTableColumn<ScopedEntity>[] = [
    { key: 'name', header: 'Grand Client name', sortValue: (e) => e.name, render: (e) => e.name },
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
          <Button variant="ghost" size="sm" onClick={() => toggleStatus(e.id)}>
            {e.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Grand Clients</h1>
      </div>

      <DataTable
        rows={entities}
        columns={columns}
        getRowId={(e) => e.id}
        searchPlaceholder="Search Grand Clients…"
        searchPredicate={(e, q) => e.name.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<Button onClick={() => setCreateOpen(true)}>Create Grand Client</Button>}
        emptyState="No Grand Clients yet."
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
