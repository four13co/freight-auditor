import { Navigate } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';

/**
 * Placeholder only -- the real login form (email/password + passkey) is
 * 86e3a6r65's job. Rendered inside AuthLayout's <Outlet/>, so this owns no
 * layout chrome of its own.
 */
export default function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">Login form coming soon.</p>
    </div>
  );
}
