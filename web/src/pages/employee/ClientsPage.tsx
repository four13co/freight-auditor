import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
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
import { countScopedEntities } from '@/lib/in-memory-hierarchy-store';
import { createClient, fetchTenantSummaries, updateClient, type TenantSummary } from '@/lib/api';
import { useTenant } from '@/providers/TenantProvider';

function ClientFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { name: string };
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) setName(initial?.name ?? '');
  }, [open, initial]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    await onSubmit(name);
    setIsSubmitting(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{initial ? 'Edit client' : 'Create client'}</DialogTitle>
            <DialogDescription>
              {initial ? 'Update this client&apos;s name.' : 'Adds a new client tenant.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="client-name">Name</Label>
              <Input id="client-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : initial ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ClientsPage() {
  const navigate = useNavigate();
  const { setActiveClient } = useTenant();
  const [clients, setClients] = useState<TenantSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TenantSummary | null>(null);

  async function load() {
    setIsLoading(true);
    setClients(await fetchTenantSummaries());
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function goToGrandClients(client: TenantSummary) {
    setActiveClient({ id: client.id, name: client.name });
    navigate('/employee/clients/grand-clients');
  }

  async function handleDisableToggle(client: TenantSummary) {
    const result = await updateClient(client.id, { isActive: !client.isActive });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(client.isActive ? 'Client disabled.' : 'Client enabled.');
    load();
  }

  const columns: DataTableColumn<TenantSummary>[] = [
    {
      key: 'name',
      header: 'Client name',
      sortValue: (c) => c.name,
      render: (c) => (
        <button type="button" className="font-medium hover:underline" onClick={() => goToGrandClients(c)}>
          {c.name}
        </button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (c) => (c.isActive ? 0 : 1),
      render: (c) => <Badge variant={c.isActive ? 'default' : 'secondary'}>{c.isActive ? 'Active' : 'Disabled'}</Badge>,
    },
    {
      key: 'grandClients',
      header: 'Grand Client count',
      sortValue: (c) => countScopedEntities(`client:${c.id}`),
      render: (c) => countScopedEntities(`client:${c.id}`),
    },
    {
      key: 'created',
      header: 'Created date',
      sortValue: (c) => c.createdAt,
      render: (c) => new Date(c.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => goToGrandClients(c)}>
            View Grand Clients
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleDisableToggle(c)}>
            {c.isActive ? 'Disable' : 'Enable'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
      </div>

      <DataTable
        rows={clients}
        columns={columns}
        getRowId={(c) => c.id}
        searchPlaceholder="Search clients…"
        searchPredicate={(c, q) => c.name.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<Button onClick={() => setCreateOpen(true)}>Create client</Button>}
        isLoading={isLoading}
        emptyState="No clients match this search."
      />

      <ClientFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (name) => {
          const result = await createClient({ name });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success('Client created.');
          setCreateOpen(false);
          load();
        }}
      />

      <ClientFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        initial={editing ? { name: editing.name } : undefined}
        onSubmit={async (name) => {
          if (!editing) return;
          const result = await updateClient(editing.id, { name });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success('Client updated.');
          setEditing(null);
          load();
        }}
      />
    </div>
  );
}
