import { getOwnClientId } from '@/lib/api';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

/**
 * Shared by every Client-role Grand-Client-scoped screen (86e3a6rh4/rhj/
 * rj8/rjr): lets the client pick which of their own Grand Clients (from the
 * shared in-memory-hierarchy-store's `client:<ownClientId>` scope -- the
 * exact same scope Employee's GrandClientsPage writes into) to view. Sets
 * `activeGrandClient` on TenantProvider, same context Employee's Vendors
 * page already reads, so the choice carries across all four of these pages
 * without re-selecting.
 */
export function GrandClientSelector() {
  const ownClientId = getOwnClientId();
  const scopeKey = ownClientId ? `client:${ownClientId}` : null;
  const { entities } = useScopedEntities(scopeKey);
  const { activeGrandClient, setActiveGrandClient } = useTenant();

  if (entities.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Grand Clients yet — create one from the Grand Clients page first.
      </p>
    );
  }

  return (
    <select
      aria-label="Select Grand Client"
      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
      value={activeGrandClient?.id ?? ''}
      onChange={(e) => {
        const entity = entities.find((x) => x.id === e.target.value);
        setActiveGrandClient(entity ? { id: entity.id, name: entity.name } : null);
      }}
    >
      <option value="">Select a Grand Client…</option>
      {entities.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </select>
  );
}
