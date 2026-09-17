import { Navigate } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';

/**
 * Placeholder only -- the real login form (email/password + passkey) is
 * 86e3a6r65's job. This page exists so RequireAuth has a redirect target
 * and so the "authenticated users are redirected away from /login" AC is
 * testable now.
 */
export default function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Login form coming soon.
        </p>
      </div>
    </main>
  );
}
