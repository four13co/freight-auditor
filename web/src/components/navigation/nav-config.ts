import {
  Building,
  Building2,
  FileSliders,
  Home,
  Truck,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { AppRole } from '@/providers/auth-provider';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** Rendered as a real page (HomePage); everything else is a placeholder stub. */
  isHome?: boolean;
  children?: NavItem[];
}

/**
 * 86e3a6r9c's nav tree per role, straight from the requirements
 * spreadsheet. Each leaf's `path` doubles as the route this config
 * generates in app-routes.tsx (see buildNavRoutes) -- one source of truth
 * so a nav item can never point at a route that doesn't exist.
 */
export const NAV_CONFIG: Record<AppRole, NavItem[]> = {
  employee: [
    { label: 'Home', path: '/employee/home', icon: Home, isHome: true },
    { label: 'Users', path: '/employee/users', icon: Users },
    {
      label: 'Accounts',
      path: '/employee/accounts',
      icon: Building2,
      children: [
        {
          label: 'Clients',
          path: '/employee/accounts/clients',
          icon: Building,
          children: [
            { label: 'Vendors', path: '/employee/accounts/clients/vendors', icon: Truck },
          ],
        },
      ],
    },
    { label: 'Rules & Rates', path: '/employee/rules-rates', icon: FileSliders },
  ],
  account: [
    { label: 'Home', path: '/account/home', icon: Home, isHome: true },
    { label: 'Users', path: '/account/users', icon: Users },
    { label: 'Users (Client)', path: '/account/client-users', icon: Users },
    { label: 'Users (Vendor)', path: '/account/vendor-users', icon: Users },
    { label: 'Clients', path: '/account/clients', icon: Building },
    { label: 'Client File Drop', path: '/account/clients/file-drop', icon: Upload },
    { label: 'Client Rules & Rates', path: '/account/clients/rules-rates', icon: FileSliders },
  ],
  grand_client: [
    { label: 'Home', path: '/grand-client/home', icon: Home, isHome: true },
    { label: 'Users', path: '/grand-client/users', icon: Users },
  ],
  vendor: [
    { label: 'Home', path: '/vendor/home', icon: Home, isHome: true },
    { label: 'Users', path: '/vendor/users', icon: Users },
  ],
};

/** Depth-first flatten, keeping every ancestor's item alongside each node for breadcrumb trails. */
function flattenWithTrail(items: NavItem[], trail: NavItem[] = []): { item: NavItem; trail: NavItem[] }[] {
  return items.flatMap((item) => {
    const ownTrail = [...trail, item];
    const self = { item, trail: ownTrail };
    return item.children ? [self, ...flattenWithTrail(item.children, ownTrail)] : [self];
  });
}

export function flattenNavItems(role: AppRole): NavItem[] {
  return flattenWithTrail(NAV_CONFIG[role]).map((entry) => entry.item);
}

/** Ancestor-to-self chain of {label, path} for the item at `pathname`, or `null` if nothing matches. */
export function getBreadcrumbTrail(role: AppRole, pathname: string): NavItem[] | null {
  const match = flattenWithTrail(NAV_CONFIG[role]).find((entry) => entry.item.path === pathname);
  return match ? match.trail : null;
}
