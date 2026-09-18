import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authClient, useSession, signOut as authSignOut } from '@/lib/auth-client';
import {
  ACCOUNT_ID_STORAGE_KEY,
  fetchActorContext,
  fetchAndStoreAccountId,
  type ActorContext,
} from '@/lib/api';
import { devHeaderPathActive } from '@/lib/dev-auth';

export type AppRole = 'employee' | 'account' | 'grand_client' | 'vendor';

/**
 * 86e3a6r65: where each role lands after login. Only 'employee' and
 * 'account' are reachable today (mapActorToRole's stopgap below); the other
 * two entries are forward-declared for when the role-vocabulary gap closes
 * and are otherwise dead branches. The routes themselves don't exist until
 * 86e3a6r8z (app shell) and the per-role home-screen tasks land -- same
 * forward-reference shape as AuthLayout pointing at this task's pages
 * before they existed.
 */
export const ROLE_HOME_PATH: Record<AppRole, string> = {
  employee: '/employee/home',
  account: '/account/home',
  grand_client: '/grand-client/home',
  vendor: '/vendor/home',
};

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  role: AppRole;
  isInternal: boolean;
  accountName: string | null;
}

export interface LoginResult {
  error: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  role: AppRole | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
}

/**
 * Backend membership roles (account_viewer/account_admin, per
 * src/server/auth-routes.ts) don't yet distinguish grand_client/vendor from
 * this item's four-role model -- every non-internal actor maps to 'account'
 * until the backend exposes that distinction. See this PR's Uncertainties.
 */
function mapActorToRole(ctx: ActorContext): AppRole {
  return ctx.isInternal ? 'employee' : 'account';
}

const DEV_USER: AuthUser = {
  id: 'dev-user',
  email: 'dev-dashboard@example.com',
  name: 'Dev Dashboard User',
  role: 'employee',
  isInternal: true,
  accountName: null,
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const devMode = devHeaderPathActive();

  // Real-session path only -- the dev-header path never calls useSession()'s
  // underlying network fetch's result (below, `devMode` short-circuits
  // before it's read), but the hook itself always runs (rules of hooks).
  const { data: session, isPending } = useSession();
  const [actorContext, setActorContext] = useState<ActorContext | null>(null);
  const [actorLoading, setActorLoading] = useState(false);

  const sessionUserId = session?.user?.id;
  useEffect(() => {
    if (devMode || !sessionUserId) return;
    setActorLoading(true);
    setActorContext(null);
    Promise.all([fetchAndStoreAccountId().catch(() => {}), fetchActorContext()]).then(
      ([, ctx]) => {
        setActorContext(ctx);
        setActorLoading(false);
      },
    );
  }, [devMode, sessionUserId]);

  const value = useMemo<AuthContextValue>(() => {
    if (devMode) {
      return {
        user: DEV_USER,
        role: DEV_USER.role,
        isAuthenticated: true,
        isLoading: false,
        login: async () => ({ error: null }),
        logout: async () => {},
      };
    }

    const isLoading = isPending || (Boolean(sessionUserId) && actorLoading);
    const sessionUser = session?.user;
    const user: AuthUser | null =
      sessionUser && actorContext
        ? {
            id: sessionUser.id,
            email: sessionUser.email ?? null,
            name: sessionUser.name ?? null,
            role: mapActorToRole(actorContext),
            isInternal: actorContext.isInternal,
            accountName: actorContext.accountName,
          }
        : null;

    return {
      user,
      role: user?.role ?? null,
      isAuthenticated: Boolean(sessionUser) && Boolean(user),
      isLoading,
      login: async (email: string, password: string) => {
        const { error } = await authClient.signIn.email({ email, password });
        return { error: error?.message ?? null };
      },
      logout: async () => {
        sessionStorage.removeItem(ACCOUNT_ID_STORAGE_KEY);
        await authSignOut();
      },
    };
  }, [devMode, isPending, session, actorContext, actorLoading, sessionUserId]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
