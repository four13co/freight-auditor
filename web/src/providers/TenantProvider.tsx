import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchClients, type TenantOption } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';

const ACTIVE_CLIENT_KEY = 'freight-auditor:active-client';

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
 * 86e3a6rak. Only the Employee role has a real backend list to switch
 * between today (GET /api/internal/tenants); Client/Grand Client/Vendor
 * scoping depends on a "Grand Client" concept the backend doesn't expose
 * yet (see this PR's Uncertainties), so `options` stays empty for them and
 * TenantPicker renders nothing -- both AC "hidden for roles that don't need
 * it" and the "no tenants" graceful-handling case, by construction.
 */
export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  const [options, setOptions] = useState<TenantOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeClientId, setActiveClientId] = useLocalStorageState<string | null>(ACTIVE_CLIENT_KEY, null);
  const [activeGrandClient, setActiveGrandClient] = useState<TenantOption | null>(null);

  useEffect(() => {
    if (role !== 'employee') {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    fetchClients().then((tenants) => {
      if (cancelled) return;
      setOptions(tenants);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [role]);

  const activeClient = useMemo(
    () => options.find((t) => t.id === activeClientId) ?? (options[0] ?? null),
    [options, activeClientId],
  );

  const value = useMemo<TenantContextValue>(
    () => ({
      options,
      isLoading,
      activeClient,
      activeGrandClient,
      setActiveClient: (tenant) => setActiveClientId(tenant?.id ?? null),
      setActiveGrandClient,
    }),
    [options, isLoading, activeClient, activeGrandClient, setActiveClientId],
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
