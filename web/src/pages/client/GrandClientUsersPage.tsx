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
import { GrandClientSelector } from '@/components/GrandClientSelector';
import { useScopedUsers, type ScopedUser } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

const ROLE_LABELS: Record<string, string> = {
  viewer: 'Viewer',
  admin: 'Admin',
};

function GrandClientUserFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { name: string; email: string; role: string };
  onSubmit: (name: string, email: string, role: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState(initial?.role ?? 'viewer');

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setEmail(initial?.email ?? '');
      setRole(initial?.role ?? 'viewer');
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(name, email, role);
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial ? 'Edit user' : 'Invite user'}</DialogTitle>
            <DialogDescription>
              In-memory for now — see this PR&apos;s Uncertainties for why there&apos;s no backend yet.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gc-user-name">Name</Label>
              <Input id="gc-user-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gc-user-email">Email</Label>
              <Input
                id="gc-user-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gc-user-role">Role</Label>
              <select
                id="gc-user-role"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="viewer">{ROLE_LABELS.viewer}</option>
                <option value="admin">{ROLE_LABELS.admin}</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">{initial ? 'Save' : 'Invite'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 86e3a6rh4: users this client manages on behalf of a selected Grand Client.
 * No backend concept of a Grand-Client-scoped user exists (same gap as
 * Grand Client/Vendor entities themselves -- PR #406's Uncertainties), so
 * this routes through the shared in-memory-hierarchy-store's ScopedUser
 * (Bridge decision on 86e3a6r3b: one shared store, no per-screen mocks),
 * scoped by `grandClientUsers:<grandClientId>`.
 */
export default function GrandClientUsersPage() {
  const { activeGrandClient } = useTenant();
  const scopeKey = activeGrandClient ? `grandClientUsers:${activeGrandClient.id}` : null;
  const { users, create, update, toggleStatus, remove } = useScopedUsers(scopeKey);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedUser | null>(null);

  const columns: DataTableColumn<ScopedUser>[] = [
    { key: 'name', header: 'Name', sortValue: (u) => u.name, render: (u) => u.name },
    { key: 'email', header: 'Email', sortValue: (u) => u.email, render: (u) => u.email },
    { key: 'grandClient', header: 'Grand Client', render: () => activeGrandClient?.name ?? '—' },
    { key: 'role', header: 'Role', sortValue: (u) => u.role, render: (u) => ROLE_LABELS[u.role] ?? u.role },
    {
      key: 'status',
      header: 'Status',
      sortValue: (u) => (u.status === 'active' ? 0 : 1),
      render: (u) => <Badge variant={u.status === 'active' ? 'default' : 'secondary'}>{u.status === 'active' ? 'Active' : 'Disabled'}</Badge>,
    },
    { key: 'lastLogin', header: 'Last login', render: () => <span className="text-muted-foreground">—</span> },
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
        <h1 className="text-2xl font-semibold tracking-tight">Users (Grand Client)</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <GrandClientSelector />
      </div>

      {!activeGrandClient ? (
        <p className="text-sm text-muted-foreground">Select a Grand Client to view its users.</p>
      ) : (
        <>
          <DataTable
            rows={users}
            columns={columns}
            getRowId={(u) => u.id}
            searchPlaceholder="Search users…"
            searchPredicate={(u, q) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase())}
            toolbarEnd={<Button onClick={() => setCreateOpen(true)}>Invite user</Button>}
            emptyState={`No users yet for ${activeGrandClient.name}.`}
          />

          <GrandClientUserFormDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onSubmit={(name, email, role) => {
              create({ name, email, role });
              setCreateOpen(false);
            }}
          />

          <GrandClientUserFormDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            initial={editing ? { name: editing.name, email: editing.email, role: editing.role } : undefined}
            onSubmit={(name, email, role) => {
              if (!editing) return;
              update(editing.id, { name, email, role });
              setEditing(null);
            }}
          />
        </>
      )}
    </div>
  );
}
