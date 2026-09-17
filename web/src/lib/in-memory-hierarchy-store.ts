import { useEffect, useState } from 'react';

/**
 * Grand Client (86e3a6ren) and Vendor (86e3a6rf3) CRUD, in-memory only.
 *
 * The backend has no "Grand Client" concept at all (grep confirms zero
 * grand_client/grandClient references anywhere in src/server/*) -- same gap
 * PR #403's Uncertainties already flagged and pushed to Bridge as
 * role-vocab-gap-86e3a6r53. There is nothing to fetch or persist to yet, so
 * this module is a deliberate stand-in: a session-lifetime, module-level Map
 * keyed by scope (a Client's id for Grand Clients, a Grand Client's id for
 * Vendors) so CRUD interactions are real and testable *as UI behavior*,
 * without pretending a backend API exists. Resets on page reload. The
 * moment a real endpoint exists, this hook's call sites swap for a
 * fetch-backed one with the same shape -- nothing else in either page
 * should need to change.
 */
export interface ScopedEntity {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: string;
  /** Vendor-only free-text field; unused by Grand Clients. */
  contactInfo?: string;
}

const stores = new Map<string, ScopedEntity[]>();

export function countScopedEntities(scopeKey: string): number {
  return stores.get(scopeKey)?.length ?? 0;
}

export function useScopedEntities(scopeKey: string | null) {
  const [entities, setEntities] = useState<ScopedEntity[]>(() => (scopeKey ? (stores.get(scopeKey) ?? []) : []));

  useEffect(() => {
    setEntities(scopeKey ? (stores.get(scopeKey) ?? []) : []);
  }, [scopeKey]);

  function persist(next: ScopedEntity[]) {
    if (scopeKey) stores.set(scopeKey, next);
    setEntities(next);
  }

  return {
    entities,
    create(input: { name: string; contactInfo?: string }) {
      if (!scopeKey) return;
      persist([
        ...entities,
        {
          id: crypto.randomUUID(),
          name: input.name,
          contactInfo: input.contactInfo,
          status: 'active',
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    update(id: string, patch: { name?: string; contactInfo?: string }) {
      persist(entities.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    },
    toggleStatus(id: string) {
      persist(entities.map((e) => (e.id === id ? { ...e, status: e.status === 'active' ? 'disabled' : 'active' } : e)));
    },
  };
}
