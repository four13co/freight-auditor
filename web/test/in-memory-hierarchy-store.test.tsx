import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { countScopedEntities, useScopedEntities, useScopedUsers } from '@/lib/in-memory-hierarchy-store';

describe('useScopedEntities', () => {
  it('creates, updates, and toggles status, scoped by key', () => {
    const scope = `test-scope-${Math.random()}`;
    const { result } = renderHook(() => useScopedEntities(scope));

    act(() => result.current.create({ name: 'Alpha' }));
    expect(result.current.entities).toHaveLength(1);
    expect(result.current.entities[0].name).toBe('Alpha');
    expect(result.current.entities[0].status).toBe('active');
    expect(countScopedEntities(scope)).toBe(1);

    const id = result.current.entities[0].id;
    act(() => result.current.update(id, { name: 'Alpha Renamed' }));
    expect(result.current.entities[0].name).toBe('Alpha Renamed');

    act(() => result.current.toggleStatus(id));
    expect(result.current.entities[0].status).toBe('disabled');
  });

  it('returns nothing for a null scope and does not persist across scopes', () => {
    const { result } = renderHook(() => useScopedEntities(null));
    expect(result.current.entities).toEqual([]);
    act(() => result.current.create({ name: 'Ignored' }));
    expect(result.current.entities).toEqual([]);
  });

  it('separate scopes never see each other\'s entities', () => {
    const scopeA = `scope-a-${Math.random()}`;
    const scopeB = `scope-b-${Math.random()}`;
    const { result: a } = renderHook(() => useScopedEntities(scopeA));
    const { result: b } = renderHook(() => useScopedEntities(scopeB));

    act(() => a.current.create({ name: 'Only in A' }));

    expect(a.current.entities).toHaveLength(1);
    expect(b.current.entities).toHaveLength(0);
  });
});

/** 86e3a6rh4/rhj: user-shaped rows in the same shared module, a separate map from useScopedEntities. */
describe('useScopedUsers', () => {
  it('creates, updates, toggles status, and removes, scoped by key', () => {
    const scope = `test-user-scope-${Math.random()}`;
    const { result } = renderHook(() => useScopedUsers(scope));

    act(() => result.current.create({ name: 'Dana', email: 'dana@test.example', role: 'viewer' }));
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].name).toBe('Dana');
    expect(result.current.users[0].status).toBe('active');

    const id = result.current.users[0].id;
    act(() => result.current.update(id, { name: 'Dana Renamed' }));
    expect(result.current.users[0].name).toBe('Dana Renamed');

    act(() => result.current.toggleStatus(id));
    expect(result.current.users[0].status).toBe('disabled');

    act(() => result.current.remove(id));
    expect(result.current.users).toHaveLength(0);
  });

  it('carries optional vendorId/vendorName for vendor-user rows', () => {
    const scope = `test-vendor-user-scope-${Math.random()}`;
    const { result } = renderHook(() => useScopedUsers(scope));

    act(() => result.current.create({ name: 'Val', email: 'val@test.example', role: 'vendor', vendorId: 'v1', vendorName: 'Acme Trucking' }));
    expect(result.current.users[0].vendorId).toBe('v1');
    expect(result.current.users[0].vendorName).toBe('Acme Trucking');
  });

  it('returns nothing for a null scope and does not persist across scopes', () => {
    const { result } = renderHook(() => useScopedUsers(null));
    expect(result.current.users).toEqual([]);
    act(() => result.current.create({ name: 'Ignored', email: 'ignored@test.example', role: 'viewer' }));
    expect(result.current.users).toEqual([]);
  });

  it('separate scopes never see each other\'s users', () => {
    const scopeA = `user-scope-a-${Math.random()}`;
    const scopeB = `user-scope-b-${Math.random()}`;
    const { result: a } = renderHook(() => useScopedUsers(scopeA));
    const { result: b } = renderHook(() => useScopedUsers(scopeB));

    act(() => a.current.create({ name: 'Only in A', email: 'a@test.example', role: 'viewer' }));

    expect(a.current.users).toHaveLength(1);
    expect(b.current.users).toHaveLength(0);
  });
});
