import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { CLIENT_ID_STORAGE_KEY, fetchClients, type TenantOption } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';

const ACTIVE_CLIENT_KEY = 'freight-auditor:active-client';
const ACTIVE_GRAND_CLIENT_KEY = 'freight-auditor:active-grand-client';

interface TenantContextValue {
  /** Every tenant the current role is allowed to switch between; empty while loading or for a scoped role with none available yet. */
  options: TenantOption[];
  isLoading: boolean;
  activeClient: TenantOption | null;
  activeGrandClient: TenantOption | null;
  setActiveClient: (tenant: TenantOption | null) => void;
  setActiveGrandClient: (tenant: TenantOption | null) => void;
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined);

/**
 * 86e3a6rak. Employee switches between every Client (GET
 * /api/internal/tenants). Client switches between their own Grand Clients,
 * sourced from `in-memory-hierarchy-store.ts` (no real `grand_client`
 * backend concept exists yet -- Bridge approved this stand-in 2026-09-17,
 * tracked separately under 86e3a76bz) scoped by the Client's own id
 * (`CLIENT_ID_STORAGE_KEY`, the same id `authHeaders()` already sends).
 * Grand Client/Vendor have no tenant to switch between, so `options` stays
 * empty for them and TenantPicker renders nothing -- both AC "hidden for
 * roles that don't need it" and the "no tenants" graceful-handling case,
 * by construction.
 *
 * `activeGrandClient`/`setActiveGrandClient` also serves the Employee's own
 * hierarchy drill-down (GrandClientsPage -> VendorsPage): an ad-hoc,
 * unpersisted selection unrelated to the Client role's own persisted pick
 * below -- only one of the two is ever live in a given session.
 */
export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  const [employeeOptions, setEmployeeOptions] = useState<TenantOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeClientId, setActiveClientId] = useLocalStorageState<string | null>(ACTIVE_CLIENT_KEY, null);
  const [employeeDrillDownGrandClient, setEmployeeDrillDownGrandClient] = useState<TenantOption | null>(null);
  const [activeGrandClientId, setActiveGrandClientId] = useLocalStorageState<string | null>(
    ACTIVE_GRAND_CLIENT_KEY,
    null,
  );

  useEffect(() => {
    if (role !== 'employee') {
      setEmployeeOptions([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    fetchClients().then((tenants) => {
      if (cancelled) return;
      setEmployeeOptions(tenants);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [role]);

  const ownClientScopeKey = useMemo(() => {
    if (role !== 'client') return null;
    const ownClientId = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    return ownClientId ? `client:${ownClientId}` : null;
  }, [role]);

  const { entities: ownGrandClients } = useScopedEntities(ownClientScopeKey);

  const clientGrandClientOptions = useMemo<TenantOption[]>(
    () => ownGrandClients.map((entity) => ({ id: entity.id, name: entity.name })),
    [ownGrandClients],
  );

  const options = role === 'employee' ? employeeOptions : role === 'client' ? clientGrandClientOptions : [];

  const activeClient = useMemo(
    () => employeeOptions.find((t) => t.id === activeClientId) ?? (employeeOptions[0] ?? null),
    [employeeOptions, activeClientId],
  );

  const clientActiveGrandClient = useMemo(
    () => clientGrandClientOptions.find((t) => t.id === activeGrandClientId) ?? (clientGrandClientOptions[0] ?? null),
    [clientGrandClientOptions, activeGrandClientId],
  );

  const activeGrandClient = role === 'client' ? clientActiveGrandClient : employeeDrillDownGrandClient;

  const value = useMemo<TenantContextValue>(
    () => ({
      options,
      isLoading,
      activeClient,
      activeGrandClient,
      setActiveClient: (tenant) => setActiveClientId(tenant?.id ?? null),
      setActiveGrandClient: (tenant) => {
        if (role === 'client') {
          setActiveGrandClientId(tenant?.id ?? null);
        } else {
          setEmployeeDrillDownGrandClient(tenant);
        }
      },
    }),
    [options, isLoading, activeClient, activeGrandClient, setActiveClientId, setActiveGrandClientId, role],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (context === undefined) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
}
