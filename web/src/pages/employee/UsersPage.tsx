import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
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
  MEMBERSHIP_ROLES,
  createTenantMember,
  deleteTenantMember,
  fetchAllUsers,
  fetchTenantSummaries,
  updateTenantMember,
  type MembershipRole,
  type TenantSummary,
  type UserRow,
} from '@/lib/api';

/**
 * 86e3a6rde: the requirements spreadsheet's role vocabulary is
 * Employee/Client/Grand Client/Vendor, but the backend's real membership
 * roles are analyst/lead/account_viewer/account_admin (MEMBERSHIP_ROLES,
 * tenant-admin-routes.ts) -- the same role-vocabulary gap already flagged
 * by 86e3a6r53 and pushed to Bridge (role-vocab-gap-86e3a6r53). Mapped here
 * for display; there is no backend concept of a Grand Client or Vendor
 * *user* at all yet (only Client-tenant memberships exist), so those two
 * labels can only ever show zero rows -- see this PR's Uncertainties.
 */
const ROLE_LABELS: Record<MembershipRole, string> = {
  analyst: 'Employee (Analyst)',
  lead: 'Employee (Lead)',
  account_viewer: 'Client (Viewer)',
  account_admin: 'Client (Admin)',
};

function CreateUserDialog({
  tenants,
  onCreated,
}: {
  tenants: TenantSummary[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<MembershipRole>('analyst');
  const [tenantId, setTenantId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function reset() {
    setEmail('');
    setFullName('');
    setRole('analyst');
    setTenantId('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) {
      toast.error('Select a tenant to assign this user to.');
      return;
    }
    setIsSubmitting(true);
    const result = await createTenantMember(tenantId, { email, fullName: fullName || null, role });
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('User created.');
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
      <Button onClick={() => setOpen(true)}>Create user</Button>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>Adds a user as a member of the selected tenant.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-email">Email</Label>
              <Input id="user-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-name">Name</Label>
              <Input id="user-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-role">Role</Label>
              <select
                id="user-role"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={role}
                onChange={(e) => setRole(e.target.value as MembershipRole)}
              >
                {MEMBERSHIP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-tenant">Tenant</Label>
              <select
                id="user-tenant"
                required
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              >
                <option value="">Select a tenant…</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
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

function EditRoleDialog({
  user,
  onOpenChange,
  onSaved,
}: {
  user: UserRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<MembershipRole>(user?.role ?? 'analyst');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (user) setRole(user.role);
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setIsSubmitting(true);
    const result = await updateTenantMember(user.tenantId, user.membershipId, { role });
    setIsSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Role updated.');
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit role</DialogTitle>
            <DialogDescription>Change this user&apos;s role for {user?.tenantName}.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-user-role">Role</Label>
              <select
                id="edit-user-role"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                value={role}
                onChange={(e) => setRole(e.target.value as MembershipRole)}
              >
                {MEMBERSHIP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
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

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<MembershipRole | 'all'>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [editing, setEditing] = useState<UserRow | null>(null);

  async function load() {
    setIsLoading(true);
    const [userRows, tenantRows] = await Promise.all([fetchAllUsers(), fetchTenantSummaries()]);
    setUsers(userRows);
    setTenants(tenantRows);
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (tenantFilter !== 'all' && u.tenantId !== tenantFilter) return false;
      if (statusFilter === 'active' && !u.isActive) return false;
      if (statusFilter === 'disabled' && u.isActive) return false;
      return true;
    });
  }, [users, roleFilter, tenantFilter, statusFilter]);

  async function handleRemove(user: UserRow) {
    const ok = await deleteTenantMember(user.tenantId, user.membershipId);
    if (!ok) {
      toast.error('Could not remove this user.');
      return;
    }
    toast.success('User removed.');
    setUsers((prev) => prev.filter((u) => u.membershipId !== user.membershipId));
  }

  async function handleToggleActive(user: UserRow) {
    const result = await updateTenantMember(user.tenantId, user.membershipId, { isActive: !user.isActive });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(user.isActive ? 'User disabled.' : 'User enabled.');
    load();
  }

  const columns: DataTableColumn<UserRow>[] = [
    { key: 'name', header: 'Name', sortValue: (u) => u.fullName ?? u.email, render: (u) => u.fullName ?? '—' },
    { key: 'email', header: 'Email', sortValue: (u) => u.email, render: (u) => u.email },
    { key: 'role', header: 'Role', sortValue: (u) => u.role, render: (u) => ROLE_LABELS[u.role] },
    { key: 'tenant', header: 'Tenant', sortValue: (u) => u.tenantName, render: (u) => u.tenantName },
    {
      key: 'status',
      header: 'Status',
      sortValue: (u) => (u.isActive ? 0 : 1),
      render: (u) => <Badge variant={u.isActive ? 'default' : 'secondary'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>,
    },
    { key: 'lastLogin', header: 'Last login', render: () => <span className="text-muted-foreground">—</span> },
    {
      key: 'created',
      header: 'Created',
      sortValue: (u) => u.createdAt,
      render: (u) => new Date(u.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (u) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
            Edit role
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleToggleActive(u)}>
            {u.isActive ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleRemove(u)}>
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

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by role"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as MembershipRole | 'all')}
        >
          <option value="all">All roles</option>
          {MEMBERSHIP_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
          <option value="grand_client" disabled>
            Grand Client (no users yet)
          </option>
          <option value="vendor" disabled>
            Vendor (no users yet)
          </option>
        </select>

        <select
          aria-label="Filter by tenant"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
        >
          <option value="all">All tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by status"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(u) => u.membershipId}
        searchPlaceholder="Search by name or email…"
        searchPredicate={(u, q) => {
          const needle = q.toLowerCase();
          return u.email.toLowerCase().includes(needle) || (u.fullName ?? '').toLowerCase().includes(needle);
        }}
        toolbarEnd={<CreateUserDialog tenants={tenants} onCreated={load} />}
        isLoading={isLoading}
        emptyState="No users match these filters."
      />

      <EditRoleDialog
        user={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    </div>
  );
}
