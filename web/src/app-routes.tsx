import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/components/require-auth';
import { RequireRole } from '@/components/require-role';
import AuthLayout from '@/layouts/AuthLayout';
import AppLayout from '@/layouts/AppLayout';
import LoginPage from '@/pages/login';
import ForgotUsernamePage from '@/pages/forgot-username';
import ForgotPasswordPage from '@/pages/forgot-password';
import ResetPasswordPage from '@/pages/reset-password';
import HomePage from '@/pages/home';
import EmployeeHomePage from '@/pages/employee/HomePage';
import { PlaceholderPage } from '@/components/navigation/PlaceholderPage';
import { NAV_CONFIG, flattenNavItems } from '@/components/navigation/nav-config';
import { ROLE_HOME_PATH, useAuth, type AppRole } from '@/providers/auth-provider';

const ROLES = Object.keys(NAV_CONFIG) as AppRole[];

/** Per-role real home screen, once built (86e3a6rbe); everything else still falls back to the shared placeholder HomePage. */
const ROLE_HOME_PAGE: Partial<Record<AppRole, () => ReactElement>> = {
  employee: EmployeeHomePage,
};

/** "/" itself: send an authenticated user straight to their role's home. */
function RoleHomeRedirect() {
  const { role, isLoading } = useAuth();
  if (isLoading) return null;
  return <Navigate to={role ? ROLE_HOME_PATH[role] : '/login'} replace />;
}

/**
 * Split out of App.tsx so tests can render this route tree inside a
 * MemoryRouter (with controlled initialEntries) instead of BrowserRouter,
 * which reads/writes the real jsdom history.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-username" element={<ForgotUsernamePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<RoleHomeRedirect />} />
        <Route element={<AppLayout />}>
          {/*
            86e3a6r9c AC ("nav items route correctly, even if pages are
            placeholder/empty for now"): one <Route> per NAV_CONFIG leaf,
            generated instead of hand-duplicated, so a nav item can never
            point at a route that doesn't exist. Grouped per role under its
            own <RequireRole> so a user can't reach another role's
            (placeholder) screens by URL.
          */}
          {ROLES.map((role) => (
            <Route key={role} element={<RequireRole roles={[role]} />}>
              {flattenNavItems(role).map((item) => {
                const RoleHome = ROLE_HOME_PAGE[role];
                let element: ReactElement;
                if (item.isHome) {
                  element = RoleHome ? <RoleHome /> : <HomePage />;
                } else {
                  element = <PlaceholderPage title={item.label} />;
                }
                return <Route key={item.path} path={item.path} element={element} />;
              })}
            </Route>
          ))}
        </Route>
      </Route>
    </Routes>
  );
}
