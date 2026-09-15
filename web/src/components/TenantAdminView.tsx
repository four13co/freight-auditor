import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchTenants, createTenant, type TenantRow } from '../lib/api.js';

/**
 * 86e38rdnm: tenant list + create form -- the entry point of the Tenant
 * Admin surface (Sidebar.tsx's "Tenants" nav item under "Admin"). Row click
 * navigates to /#/tenants/:id (TenantDetailView), a plain anchor matching
 * Sidebar.tsx's own convention (NavLink/useNavigate would require a Router
 * ancestor this component doesn't control in isolation).
 */
export function TenantAdminView() {
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setRows(null);
    fetchTenants().then(
      (result) => setRows(result),
      () => setError(true),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === '' || slug.trim() === '') {
      setCreateError('Name and slug are both required.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createTenant({ name: name.trim(), slug: slug.trim() });
      setName('');
      setSlug('');
      load();
    } catch {
      setCreateError('Could not create tenant. The slug may already be in use.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Tenants</span>
      </div>

      <form
        data-testid="tenant-create-form"
        onSubmit={(e) => {
          void handleCreate(e);
        }}
        className="flex flex-wrap items-end gap-3 px-5"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tenant-create-name" className="text-[13px] font-semibold text-[#201e1d]">
            Name
          </label>
          <input
            id="tenant-create-name"
            aria-label="Tenant name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tenant-create-slug" className="text-[13px] font-semibold text-[#201e1d]">
            Slug
          </label>
          <input
            id="tenant-create-slug"
            aria-label="Tenant slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create tenant'}
        </button>
        {createError && (
          <span data-testid="tenant-create-error" role="alert" className="text-[12px] text-[#c0290f]">
            {createError}
          </span>
        )}
      </form>

      {error && (
        <div
          data-testid="tenants-error"
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
        >
          <span>Something went wrong loading tenants.</span>
          <button type="button" onClick={load} className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold">
            Retry
          </button>
        </div>
      )}

      {!error && rows === null && (
        <div data-testid="tenants-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && rows !== null && rows.length === 0 && (
        <div data-testid="tenants-empty" role="status" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          No tenants yet.
        </div>
      )}

      {!error && rows !== null && rows.length > 0 && (
        <table data-testid="tenants-table" className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(32,30,29,0.15)] text-left">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Slug</th>
              <th className="py-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid="tenant-row" className="border-t border-[rgba(32,30,29,0.1)]">
                <td className="py-2 pr-4 font-semibold">
                  <a href={`#/tenants/${row.id}`} className="hover:underline">
                    {row.name}
                  </a>
                </td>
                <td className="py-2 pr-4">{row.slug}</td>
                <td className="py-2 pr-4">{row.isActive ? 'Active' : 'Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
