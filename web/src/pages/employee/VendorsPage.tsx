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
import { useScopedEntities, type ScopedEntity } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

function VendorFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { name: string; contactInfo?: string };
  onSubmit: (name: string, contactInfo: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [contactInfo, setContactInfo] = useState(initial?.contactInfo ?? '');

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setContactInfo(initial?.contactInfo ?? '');
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(name, contactInfo);
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial ? 'Edit vendor' : 'Create vendor'}</DialogTitle>
            <DialogDescription>
              In-memory for now — see this PR&apos;s Uncertainties for why there&apos;s no backend yet.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-name">Name</Label>
              <Input id="vendor-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-contact">Contact info</Label>
              <Input id="vendor-contact" value={contactInfo} onChange={(e) => setContactInfo(e.target.value)} />
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

export default function VendorsPage() {
  const { activeGrandClient } = useTenant();
  const scopeKey = activeGrandClient ? `client:${activeGrandClient.id}` : null;
  const { entities, create, update, toggleStatus } = useScopedEntities(scopeKey);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedEntity | null>(null);

  const columns: DataTableColumn<ScopedEntity>[] = [
    { key: 'name', header: 'Vendor name', sortValue: (e) => e.name, render: (e) => e.name },
    {
      key: 'status',
      header: 'Status',
      sortValue: (e) => (e.status === 'active' ? 0 : 1),
      render: (e) => <Badge variant={e.status === 'active' ? 'default' : 'secondary'}>{e.status === 'active' ? 'Active' : 'Disabled'}</Badge>,
    },
    { key: 'contact', header: 'Contact info', render: (e) => e.contactInfo || '—' },
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

  if (!activeGrandClient) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <p className="text-sm text-muted-foreground">Select a Client to view its vendors.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Vendors for {activeGrandClient.name}</h1>
      </div>

      <DataTable
        rows={entities}
        columns={columns}
        getRowId={(e) => e.id}
        searchPlaceholder="Search vendors…"
        searchPredicate={(e, q) => e.name.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<Button onClick={() => setCreateOpen(true)}>Create vendor</Button>}
        emptyState={`No vendors yet for ${activeGrandClient.name}.`}
      />

      <VendorFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(name, contactInfo) => {
          create({ name, contactInfo });
          setCreateOpen(false);
        }}
      />

      <VendorFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        initial={editing ? { name: editing.name, contactInfo: editing.contactInfo } : undefined}
        onSubmit={(name, contactInfo) => {
          if (!editing) return;
          update(editing.id, { name, contactInfo });
          setEditing(null);
        }}
      />
    </div>
  );
}
