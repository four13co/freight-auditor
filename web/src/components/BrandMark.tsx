import type { Branding } from '../lib/api.js';

/**
 * 86e320pkc: the app-shell logo swatch, shared by Sidebar.tsx (internal
 * Dashboard) and PortalApp.tsx (client portal nav) -- both previously drew
 * their own identical static 22x22 red square. When a Customer has
 * configured a domain/logo (branding.branded), this renders their logo
 * instead; otherwise it renders the platform default swatch, tinted by
 * --brand-primary when set (see App.tsx) with a CSS fallback to the
 * platform's own red so an unbranded visit renders exactly as before.
 */
export function BrandMark({ branding }: { branding?: Branding | null }) {
  if (branding?.branded && branding.logoUrl) {
    return (
      <img
        src={branding.logoUrl}
        alt=""
        data-testid="brand-mark-logo"
        className="h-[22px] w-[22px] object-contain"
      />
    );
  }
  return (
    <div
      data-testid="brand-mark-default"
      className="h-[22px] w-[22px]"
      style={{ backgroundColor: 'var(--brand-primary, #ec3013)' }}
    />
  );
}
