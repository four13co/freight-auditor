import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { countScopedEntities, useScopedEntities } from '@/lib/in-memory-hierarchy-store';

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
