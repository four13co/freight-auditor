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
      label: 'Clients',
      path: '/employee/clients',
      icon: Building2,
      children: [
        {
          label: 'Grand Clients',
          path: '/employee/clients/grand-clients',
          icon: Building,
          children: [
            { label: 'Vendors', path: '/employee/clients/grand-clients/vendors', icon: Truck },
          ],
        },
      ],
    },
    { label: 'Rules & Rates', path: '/employee/rules-rates', icon: FileSliders },
  ],
  client: [
    { label: 'Home', path: '/client/home', icon: Home, isHome: true },
    { label: 'Users', path: '/client/users', icon: Users },
    { label: 'Users (Grand Client)', path: '/client/grand-client-users', icon: Users },
    { label: 'Users (Vendor)', path: '/client/vendor-users', icon: Users },
    { label: 'Grand Clients', path: '/client/grand-clients', icon: Building },
    { label: 'Grand Client File Drop', path: '/client/grand-clients/file-drop', icon: Upload },
    { label: 'Grand Client Rules & Rates', path: '/client/grand-clients/rules-rates', icon: FileSliders },
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
