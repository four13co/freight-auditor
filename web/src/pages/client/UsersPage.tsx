import { useEffect, useState } from 'react';
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
import {
  createPortalMember,
  fetchPortalMembers,
  removePortalMember,
  updatePortalMemberRole,
  type PortalMember,
} from '@/lib/api';

const ROLE_LABELS: Record<PortalMember['role'], string> = {
  client_viewer: 'Viewer',
  client_admin: 'Admin',
};

function InviteUserDialog({ onInvited }: { onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PortalMember['role']>('client_viewer');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function reset() {
    setEmail('');
    setRole('client_viewer');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    const result = await createPortalMember({ email, role });
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('User invited.');
    reset();
    setOpen(false);
    onInvited();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button onClick={() => setOpen(true)}>Invite user</Button>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>Adds a user to this client's own portal roster.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="portal-user-email">Email</Label>
              <Input id="portal-user-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="portal-user-role">Role</Label>
              <select
                id="portal-user-role"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={role}
                onChange={(e) => setRole(e.target.value as PortalMember['role'])}
              >
                <option value="client_viewer">{ROLE_LABELS.client_viewer}</option>
                <option value="client_admin">{ROLE_LABELS.client_admin}</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Inviting…' : 'Invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 86e3a6rgu: this client's own portal roster, via the real
 * GET /api/portal/members + PATCH .../role + POST (invite) + DELETE
 * (remove) (portal-admin-routes.ts) -- all tenant-scoped server-side, so no
 * client-side tenant filter is needed the way Employee's UsersPage needs
 * one.
 *
 * Disclosed gap: PortalMemberRow (list-portal-members.ts) is
 * id/userId/email/role/createdAt only -- no name, status, or last-login
 * column exists on the backend. Name/Status/Last login render as "—"
 * rather than being fabricated. Reset-password has no backend route (no
 * admin-triggered reset flow exists via better-auth) and is out of scope
 * here -- Invite/Edit(role)/Remove are all real; see this PR's
 * Uncertainties.
 */
export default function UsersPage() {
  const [members, setMembers] = useState<PortalMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  async function load() {
    setIsLoading(true);
    setMembers(await fetchPortalMembers());
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRoleToggle(member: PortalMember) {
    const nextRole = member.role === 'client_admin' ? 'client_viewer' : 'client_admin';
    const result = await updatePortalMemberRole(member.id, nextRole);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Role updated.');
    load();
  }

  async function handleRemove(member: PortalMember) {
    const ok = await removePortalMember(member.id);
    if (!ok) {
      toast.error('Could not remove this user.');
      return;
    }
    toast.success('User removed.');
    setMembers((prev) => prev.filter((m) => m.id !== member.id));
  }

  const columns: DataTableColumn<PortalMember>[] = [
    { key: 'email', header: 'Email', sortValue: (m) => m.email, render: (m) => m.email },
    {
      key: 'role',
      header: 'Role',
      sortValue: (m) => m.role,
      render: (m) => <Badge variant={m.role === 'client_admin' ? 'default' : 'secondary'}>{ROLE_LABELS[m.role]}</Badge>,
    },
    { key: 'status', header: 'Status', render: () => <span className="text-muted-foreground">—</span> },
    { key: 'lastLogin', header: 'Last login', render: () => <span className="text-muted-foreground">—</span> },
    {
      key: 'created',
      header: 'Created',
      sortValue: (m) => m.createdAt,
      render: (m) => new Date(m.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (m) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => handleRoleToggle(m)}>
            Make {m.role === 'client_admin' ? 'Viewer' : 'Admin'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleRemove(m)}>
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      </div>

      <DataTable
        rows={members}
        columns={columns}
        getRowId={(m) => m.id}
        searchPlaceholder="Search by email…"
        searchPredicate={(m, q) => m.email.toLowerCase().includes(q.toLowerCase())}
        toolbarEnd={<InviteUserDialog onInvited={load} />}
        isLoading={isLoading}
        emptyState="No users yet."
      />
    </div>
  );
}
