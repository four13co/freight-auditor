import { describe, it, expect } from 'vitest';
import { navItemClassName, navItemStyle } from '../src/lib/nav-item.js';

describe('navItemClassName', () => {
  it('includes the active background/text classes when active', () => {
    const cn = navItemClassName(true);
    expect(cn).toMatch(/\bbg-sidebar-active\b/);
    expect(cn).toMatch(/\btext-sidebar-fg\b/);
    expect(cn).not.toMatch(/\bborder-transparent\b/);
  });

  it('includes the inactive border/text classes when not active', () => {
    const cn = navItemClassName(false);
    expect(cn).toMatch(/\bborder-transparent\b/);
    expect(cn).toMatch(/\btext-sidebar-fg-85\b/);
    expect(cn).not.toMatch(/\bbg-sidebar-active\b/);
  });
});

describe('navItemStyle', () => {
  it('returns the brand-primary left-border accent when active', () => {
    expect(navItemStyle(true)).toEqual({ borderLeftColor: 'var(--brand-primary, #ec3013)' });
  });

  it('returns undefined when not active', () => {
    expect(navItemStyle(false)).toBeUndefined();
  });
});
