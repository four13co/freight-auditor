import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { fetchPortalMembers, updatePortalMemberRole, type PortalMember } from '@/lib/api';

const ROLE_LABELS: Record<PortalMember['role'], string> = {
  account_viewer: 'Viewer',
  account_admin: 'Admin',
};

/**
 * 86e3a6rgu: this client's own portal roster, via the real
 * GET /api/portal/members + PATCH /api/portal/members/:id/role
 * (portal-admin-routes.ts) -- both already tenant-scoped server-side, so no
 * client-side tenant filter is needed the way Employee's UsersPage needs
 * one.
 *
 * Disclosed gap: PortalMemberRow (list-portal-members.ts) is
 * id/userId/email/role/createdAt only -- no name, status, or last-login
 * column exists on the backend, and there is no invite (create) or
 * disable/remove route on this surface yet, only list + role-update. Name/
 * Status/Last login render as "—" rather than being fabricated, and the
 * only row action is a role toggle; Invite/Disable/Remove/Reset-password
 * aren't buildable against real accounts without a real backend route for
 * them (see this PR's Uncertainties).
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
    const nextRole = member.role === 'account_admin' ? 'account_viewer' : 'account_admin';
    const result = await updatePortalMemberRole(member.id, nextRole);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Role updated.');
    load();
  }

  const columns: DataTableColumn<PortalMember>[] = [
    { key: 'email', header: 'Email', sortValue: (m) => m.email, render: (m) => m.email },
    {
      key: 'role',
      header: 'Role',
      sortValue: (m) => m.role,
      render: (m) => <Badge variant={m.role === 'account_admin' ? 'default' : 'secondary'}>{ROLE_LABELS[m.role]}</Badge>,
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
        <Button variant="ghost" size="sm" onClick={() => handleRoleToggle(m)}>
          Make {m.role === 'account_admin' ? 'Viewer' : 'Admin'}
        </Button>
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
        isLoading={isLoading}
        emptyState="No users yet."
      />
    </div>
  );
}
