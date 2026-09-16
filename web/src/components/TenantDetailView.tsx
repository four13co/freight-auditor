import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  fetchTenantDetail,
  updateTenant,
  createTenantBranding,
  updateTenantBranding,
  fetchTenantMembers,
  addTenantMember,
  removeTenantMember,
  type TenantDetail,
  type TenantMemberRow,
} from '../lib/api.js';
import { useClientPortalResource } from '../lib/use-client-portal-resource.js';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MEMBERSHIP_ROLES = ['analyst', 'lead', 'client_viewer', 'client_admin'] as const;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type Tab = 'info' | 'branding' | 'members';

/**
 * 86e38rdnm: tenant detail -- Info / Branding / Members tabs. Branding tab
 * toggles between CREATE (POST, fresh tenant) and UPDATE (PATCH, existing
 * row) based on `detail.branding`, per this item's own Solution text.
 */
export function TenantDetailView() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('info');
  const { data: detail, error, reload, setData: setDetail } = useClientPortalResource<TenantDetail>(
    () => (id ? fetchTenantDetail(id) : null),
    [id],
  );

  if (!id) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">
          {detail ? detail.name : 'Tenant'}
        </span>
      </div>

      {error && (
        <div data-testid="tenant-detail-error" role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]">
          <span>Something went wrong loading this tenant.</span>
          <button type="button" onClick={reload} className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold">
            Retry
          </button>
        </div>
      )}

      {!error && detail === null && (
        <div data-testid="tenant-detail-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && detail !== null && (
        <>
          <div className="flex gap-1 px-5" role="tablist">
            {(['info', 'branding', 'members'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                data-testid={`tenant-tab-${t}`}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-[13px] font-extrabold capitalize ${
                  tab === t ? 'border-b-2 border-[#ec3013] text-[#201e1d]' : 'text-[rgba(32,30,29,0.6)]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'info' && <InfoTab detail={detail} onSaved={setDetail} />}
          {tab === 'branding' && <BrandingTab detail={detail} onSaved={setDetail} />}
          {tab === 'members' && <MembersTab tenantId={id} />}
        </>
      )}
    </div>
  );
}

function InfoTab({ detail, onSaved }: { detail: TenantDetail; onSaved: (detail: TenantDetail) => void }) {
  const [name, setName] = useState(detail.name);
  const [isActive, setIsActive] = useState(detail.isActive);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('saving');
    try {
      const updated = await updateTenant(detail.id, { name, isActive });
      onSaved({ ...detail, name: updated.name, isActive: updated.isActive });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <form
      data-testid="tenant-info-form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="flex max-w-md flex-col gap-4 px-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tenant-info-name" className="text-[13px] font-semibold text-[#201e1d]">
          Name
        </label>
        <input
          id="tenant-info-name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-[#201e1d]">Slug</span>
        <span data-testid="tenant-info-slug" className="text-sm text-[rgba(32,30,29,0.7)]">
          {detail.slug}
        </span>
      </div>
      <label className="flex items-center gap-2 text-[13px] font-semibold text-[#201e1d]">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={status === 'saving'} className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60">
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' && (
          <span data-testid="tenant-info-saved" role="status" className="text-[13px] font-semibold text-[#1a7f37]">
            Saved
          </span>
        )}
        {status === 'error' && (
          <span data-testid="tenant-info-error" role="alert" className="text-[13px] font-semibold text-[#c0290f]">
            Save failed. Try again.
          </span>
        )}
      </div>
    </form>
  );
}

function BrandingTab({ detail, onSaved }: { detail: TenantDetail; onSaved: (detail: TenantDetail) => void }) {
  const isCreate = detail.branding === null;
  const [domain, setDomain] = useState(detail.branding?.domain ?? '');
  const [logoUrl, setLogoUrl] = useState(detail.branding?.logoUrl ?? '');
  const [primaryColor, setPrimaryColor] = useState(detail.branding?.primaryColor ?? '');
  const [secondaryColor, setSecondaryColor] = useState(detail.branding?.secondaryColor ?? '');
  const [errors, setErrors] = useState<{ domain?: string; logoUrl?: string; primaryColor?: string; secondaryColor?: string }>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  function validate() {
    const next: typeof errors = {};
    if (isCreate && domain.trim() === '') next.domain = 'Enter a domain.';
    if (!logoUrl.trim() || !isValidHttpUrl(logoUrl)) next.logoUrl = 'Enter a valid http(s) URL.';
    if (!primaryColor.trim() || !HEX_COLOR_PATTERN.test(primaryColor)) next.primaryColor = 'Enter a valid hex color, e.g. #112233.';
    if (secondaryColor.trim() !== '' && !HEX_COLOR_PATTERN.test(secondaryColor)) next.secondaryColor = 'Enter a valid hex color, e.g. #112233, or leave blank.';
    return next;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setStatus('saving');
    try {
      const secondary = secondaryColor.trim() === '' ? null : secondaryColor;
      const branding = isCreate
        ? await createTenantBranding(detail.id, { domain: domain.trim(), logoUrl, primaryColor, secondaryColor: secondary })
        : await updateTenantBranding(detail.id, { logoUrl, primaryColor, secondaryColor: secondary });
      const domainValue = isCreate ? domain.trim() : detail.branding!.domain;
      onSaved({ ...detail, branding: { ...branding, domain: domainValue } });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <form
      data-testid="tenant-branding-form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="flex max-w-md flex-col gap-4 px-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tenant-branding-domain" className="text-[13px] font-semibold text-[#201e1d]">
          Domain
        </label>
        <input
          id="tenant-branding-domain"
          aria-label="Domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          disabled={!isCreate}
          className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none disabled:opacity-60"
        />
        {errors.domain && (
          <span data-testid="tenant-branding-domain-error" role="alert" className="text-[12px] text-[#c0290f]">
            {errors.domain}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="tenant-branding-logo-url" className="text-[13px] font-semibold text-[#201e1d]">
          Logo URL
        </label>
        <input
          id="tenant-branding-logo-url"
          aria-label="Logo URL"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
        />
        {errors.logoUrl && (
          <span data-testid="tenant-branding-logo-url-error" role="alert" className="text-[12px] text-[#c0290f]">
            {errors.logoUrl}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="tenant-branding-primary-color" className="text-[13px] font-semibold text-[#201e1d]">
          Primary color
        </label>
        <div className="flex items-center gap-2">
          <span data-testid="tenant-branding-primary-swatch" className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]" style={{ background: HEX_COLOR_PATTERN.test(primaryColor) ? primaryColor : 'transparent' }} />
          <input
            id="tenant-branding-primary-color"
            aria-label="Primary color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        {errors.primaryColor && (
          <span data-testid="tenant-branding-primary-color-error" role="alert" className="text-[12px] text-[#c0290f]">
            {errors.primaryColor}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="tenant-branding-secondary-color" className="text-[13px] font-semibold text-[#201e1d]">
          Secondary color
        </label>
        <div className="flex items-center gap-2">
          <span data-testid="tenant-branding-secondary-swatch" className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]" style={{ background: HEX_COLOR_PATTERN.test(secondaryColor) ? secondaryColor : 'transparent' }} />
          <input
            id="tenant-branding-secondary-color"
            aria-label="Secondary color"
            value={secondaryColor}
            onChange={(e) => setSecondaryColor(e.target.value)}
            className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        {errors.secondaryColor && (
          <span data-testid="tenant-branding-secondary-color-error" role="alert" className="text-[12px] text-[#c0290f]">
            {errors.secondaryColor}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={status === 'saving'} className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60">
          {status === 'saving' ? 'Saving…' : isCreate ? 'Create branding' : 'Save'}
        </button>
        {status === 'saved' && (
          <span data-testid="tenant-branding-saved" role="status" className="text-[13px] font-semibold text-[#1a7f37]">
            Saved
          </span>
        )}
        {status === 'error' && (
          <span data-testid="tenant-branding-error" role="alert" className="text-[13px] font-semibold text-[#c0290f]">
            Save failed. Try again.
          </span>
        )}
      </div>
    </form>
  );
}

function MembersTab({ tenantId }: { tenantId: string }) {
  const { data: members, error, reload } = useClientPortalResource<TenantMemberRow[]>(
    () => fetchTenantMembers(tenantId),
    [tenantId],
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('client_admin');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (email.trim() === '') {
      setAddError('Enter an email address.');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await addTenantMember(tenantId, { email: email.trim(), role });
      setEmail('');
      reload();
    } catch {
      setAddError('Could not add member. They may already have access.');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(membershipId: string) {
    await removeTenantMember(tenantId, membershipId);
    reload();
  }

  return (
    <div className="flex flex-col gap-4 px-5">
      <form
        data-testid="tenant-member-add-form"
        onSubmit={(e) => {
          void handleAdd(e);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tenant-member-email" className="text-[13px] font-semibold text-[#201e1d]">
            Email
          </label>
          <input
            id="tenant-member-email"
            aria-label="Member email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tenant-member-role" className="text-[13px] font-semibold text-[#201e1d]">
            Role
          </label>
          <select
            id="tenant-member-role"
            aria-label="Member role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          >
            {MEMBERSHIP_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={adding} className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60">
          {adding ? 'Adding…' : 'Add member'}
        </button>
        {addError && (
          <span data-testid="tenant-member-add-error" role="alert" className="text-[12px] text-[#c0290f]">
            {addError}
          </span>
        )}
      </form>

      {error && (
        <div data-testid="tenant-members-error" role="alert" className="text-sm text-[rgba(32,30,29,0.75)]">
          Something went wrong loading members.
        </div>
      )}

      {!error && members === null && (
        <div data-testid="tenant-members-loading" className="text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && members !== null && members.length === 0 && (
        <div data-testid="tenant-members-empty" role="status" className="text-sm text-[rgba(32,30,29,0.6)]">
          No members yet.
        </div>
      )}

      {!error && members !== null && members.length > 0 && (
        <table data-testid="tenant-members-table" className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(32,30,29,0.15)] text-left">
              <th className="py-2 pr-4">Email</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4" />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} data-testid="tenant-member-row" className="border-t border-[rgba(32,30,29,0.1)]">
                <td className="py-2 pr-4">{member.email}</td>
                <td className="py-2 pr-4">{member.role}</td>
                <td className="py-2 pr-4">
                  <button
                    type="button"
                    data-testid="tenant-member-remove"
                    onClick={() => {
                      void handleRemove(member.id);
                    }}
                    className="text-[12px] font-semibold text-[#c0290f]"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
