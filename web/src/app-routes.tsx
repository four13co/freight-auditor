import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/components/require-auth';
import AuthLayout from '@/layouts/AuthLayout';
import LoginPage from '@/pages/login';
import ForgotUsernamePage from '@/pages/forgot-username';
import ResetPasswordPage from '@/pages/reset-password';
import HomePage from '@/pages/home';

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
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomePage />} />
      </Route>
    </Routes>
  );
}
