import type { CSSProperties } from 'react';

/**
 * Shared active/inactive styling for a sidebar-style nav row (86e39qa7e).
 * Plain functions, not a component -- Sidebar.tsx's NavAnchor renders a
 * plain `<a>` with no Router ancestor (Sidebar.test.tsx renders `<Sidebar />`
 * standalone), while PortalApp.tsx's PortalNav drives the same classes/style
 * off react-router's NavLink `isActive` render-prop. A component would force
 * one of the two call sites into the other's rendering mechanism.
 */
export function navItemClassName(active: boolean): string {
  return `border-l-2 px-[16px] py-[9px] text-sm font-medium ${
    active ? 'bg-sidebar-active text-sidebar-fg' : 'border-transparent text-sidebar-fg-85'
  }`;
}

export function navItemStyle(active: boolean): CSSProperties | undefined {
  return active ? { borderLeftColor: 'var(--brand-primary, #ec3013)' } : undefined;
}
