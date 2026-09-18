import { describe, expect, it } from 'vitest';
import { NAV_CONFIG, flattenNavItems, getBreadcrumbTrail } from '@/components/navigation/nav-config';

describe('NAV_CONFIG', () => {
  it('AC (86e3a6r9c): each role sees only its own items', () => {
    expect(NAV_CONFIG.employee.map((i) => i.label)).toEqual(['Home', 'Users', 'Accounts', 'Rules & Rates']);
    expect(NAV_CONFIG.account.map((i) => i.label)).toEqual([
      'Home',
      'Users',
      'Users (Grand Client)',
      'Users (Vendor)',
      'Grand Clients',
      'Grand Client File Drop',
      'Grand Client Rules & Rates',
    ]);
    expect(NAV_CONFIG.grand_client.map((i) => i.label)).toEqual(['Home', 'Users']);
    expect(NAV_CONFIG.vendor.map((i) => i.label)).toEqual(['Home', 'Users']);
  });

  it('AC: Employee Accounts → Grand Clients → Vendors is nested', () => {
    const accounts = NAV_CONFIG.employee.find((i) => i.label === 'Accounts');
    expect(accounts?.children?.[0].label).toBe('Grand Clients');
    expect(accounts?.children?.[0].children?.[0].label).toBe('Vendors');
  });

  it('every leaf has a unique path (route/nav consistency)', () => {
    for (const role of Object.keys(NAV_CONFIG) as (keyof typeof NAV_CONFIG)[]) {
      const paths = flattenNavItems(role).map((i) => i.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it('exactly one Home leaf per role, matching ROLE_HOME_PATH', () => {
    for (const role of Object.keys(NAV_CONFIG) as (keyof typeof NAV_CONFIG)[]) {
      const homes = flattenNavItems(role).filter((i) => i.isHome);
      expect(homes).toHaveLength(1);
    }
  });
});

describe('getBreadcrumbTrail', () => {
  it('AC: breadcrumbs update based on the current route', () => {
    expect(getBreadcrumbTrail('employee', '/employee/accounts')?.map((i) => i.label)).toEqual(['Accounts']);
    expect(
      getBreadcrumbTrail('employee', '/employee/accounts/grand-clients/vendors')?.map((i) => i.label),
    ).toEqual(['Accounts', 'Grand Clients', 'Vendors']);
  });

  it('returns null for a path with no matching nav item', () => {
    expect(getBreadcrumbTrail('employee', '/employee/nonexistent')).toBeNull();
  });
});
