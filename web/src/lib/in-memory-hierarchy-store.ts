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

/**
 * Client-scoped Grand Client users (86e3a6rh4) and Vendor users (86e3a6rhj),
 * in-memory only -- same reasoning and the same shared module as
 * ScopedEntity above (Bridge decision on task 86e3a6r3b / PR #406: route
 * every Grand Client/Vendor screen through this one store, no per-screen
 * mocks). A separate map from `stores` because these rows are user-shaped
 * (email/role) rather than entity-shaped (name/contactInfo), but the same
 * scope-key convention: `grandClientUsers:<grandClientId>` and
 * `vendorUsers:<grandClientId>`.
 */
export interface ScopedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: 'active' | 'disabled';
  createdAt: string;
  /** Vendor-user-only: which Vendor entity (from that Grand Client's `grandClient:<id>` scope) this user belongs to. Unused by Grand-Client-scoped users. */
  vendorId?: string;
  vendorName?: string;
}

const userStores = new Map<string, ScopedUser[]>();

export function useScopedUsers(scopeKey: string | null) {
  const [users, setUsers] = useState<ScopedUser[]>(() => (scopeKey ? (userStores.get(scopeKey) ?? []) : []));

  useEffect(() => {
    setUsers(scopeKey ? (userStores.get(scopeKey) ?? []) : []);
  }, [scopeKey]);

  function persist(next: ScopedUser[]) {
    if (scopeKey) userStores.set(scopeKey, next);
    setUsers(next);
  }

  return {
    users,
    create(input: { name: string; email: string; role: string; vendorId?: string; vendorName?: string }) {
      if (!scopeKey) return;
      persist([
        ...users,
        {
          id: crypto.randomUUID(),
          name: input.name,
          email: input.email,
          role: input.role,
          vendorId: input.vendorId,
          vendorName: input.vendorName,
          status: 'active',
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    update(id: string, patch: { name?: string; email?: string; role?: string; vendorId?: string; vendorName?: string }) {
      persist(users.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    },
    toggleStatus(id: string) {
      persist(users.map((u) => (u.id === id ? { ...u, status: u.status === 'active' ? 'disabled' : 'active' } : u)));
    },
    remove(id: string) {
      persist(users.filter((u) => u.id !== id));
    },
  };
}

/**
 * Grand-Client-scoped Rules/Rates stand-ins (86e3a6rjr). The real
 * Rules/Rates surface (`/api/rules`, `/api/internal/tenants/:id/rates`,
 * PR #407) is internal-analyst-only server-side either way (rules) or
 * tenant-scoped to a REAL tenant, not a Grand Client (rates) -- there is no
 * backend concept of "rules/rates for a Grand Client" to fetch at all, same
 * gap as the Grand Client entity itself. Read-only in the page (86e3a6rjr's
 * own AC: "Default to read-only... add edit as backend supports it"), but
 * `create` is kept on the hook (unused by the page today) so a future
 * "propose a rule" enhancement -- named as a TBD in that task's own body --
 * has somewhere real to write, without a second store.
 */
export interface ScopedRule {
  id: string;
  name: string;
  tier: 'STANDARD' | 'CLIENT' | 'CONTRACT';
  kind: 'GATING' | 'SCORING';
  status: string;
  createdAt: string;
}

const ruleStores = new Map<string, ScopedRule[]>();

export function useScopedRules(scopeKey: string | null) {
  const [rules, setRules] = useState<ScopedRule[]>(() => (scopeKey ? (ruleStores.get(scopeKey) ?? []) : []));

  useEffect(() => {
    setRules(scopeKey ? (ruleStores.get(scopeKey) ?? []) : []);
  }, [scopeKey]);

  return {
    rules,
    create(input: { name: string; tier: ScopedRule['tier']; kind: ScopedRule['kind'] }) {
      if (!scopeKey) return;
      const next = [
        ...rules,
        { id: crypto.randomUUID(), name: input.name, tier: input.tier, kind: input.kind, status: 'ACTIVE', createdAt: new Date().toISOString() },
      ];
      ruleStores.set(scopeKey, next);
      setRules(next);
    },
  };
}

export interface ScopedRate {
  id: string;
  category: string;
  amount: string;
  currency: string;
  createdAt: string;
}

const rateStores = new Map<string, ScopedRate[]>();

export function useScopedRates(scopeKey: string | null) {
  const [rates, setRates] = useState<ScopedRate[]>(() => (scopeKey ? (rateStores.get(scopeKey) ?? []) : []));

  useEffect(() => {
    setRates(scopeKey ? (rateStores.get(scopeKey) ?? []) : []);
  }, [scopeKey]);

  return {
    rates,
    create(input: { category: string; amount: string; currency: string }) {
      if (!scopeKey) return;
      const next = [
        ...rates,
        { id: crypto.randomUUID(), category: input.category, amount: input.amount, currency: input.currency, createdAt: new Date().toISOString() },
      ];
      rateStores.set(scopeKey, next);
      setRates(next);
    },
  };
}

/**
 * Grand-Client-scoped file drop uploads (86e3a6rj8), in-memory only -- same
 * gap as every other Grand-Client-scoped screen (Bridge decision on
 * 86e3a6r3b): a real upload route (portal-contract-upload-routes.ts's
 * pattern) needs a real `client_id` and an existing domain row (contract,
 * carrier) to attach to, and Grand Client is neither a real tenant nor a
 * real row anywhere in the schema. Scoped by `grandClientFiles:<id>`.
 */
export interface ScopedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  status: 'submitted' | 'processing' | 'complete' | 'failed';
  uploadedAt: string;
}

const fileStores = new Map<string, ScopedFile[]>();

export function useScopedFiles(scopeKey: string | null) {
  const [files, setFiles] = useState<ScopedFile[]>(() => (scopeKey ? (fileStores.get(scopeKey) ?? []) : []));

  useEffect(() => {
    setFiles(scopeKey ? (fileStores.get(scopeKey) ?? []) : []);
  }, [scopeKey]);

  return {
    files,
    /**
     * Functional setState (not a `persist(next)` computed from the outer
     * `files` closure, unlike the other hooks above): multiple files
     * dropped together each run their own independent progress-timer
     * closure (GrandClientFileDropPage), so two `submit` calls can land
     * within the same render's stale `files` snapshot -- reading `prev` at
     * apply time is what keeps a second concurrent upload from clobbering
     * the first.
     */
    submit(input: { name: string; type: string; size: number }) {
      if (!scopeKey) return;
      setFiles((prev) => {
        const next = [
          ...prev,
          { id: crypto.randomUUID(), name: input.name, type: input.type, size: input.size, status: 'submitted' as const, uploadedAt: new Date().toISOString() },
        ];
        fileStores.set(scopeKey, next);
        return next;
      });
    },
    remove(id: string) {
      if (!scopeKey) return;
      setFiles((prev) => {
        const next = prev.filter((f) => f.id !== id);
        fileStores.set(scopeKey, next);
        return next;
      });
    },
  };
}
