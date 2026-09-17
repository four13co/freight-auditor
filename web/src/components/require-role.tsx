import { Navigate, Outlet } from 'react-router-dom';
import { useAuth, type AppRole } from '@/providers/auth-provider';

export function RequireRole({ roles }: { roles: AppRole[] }) {
  const { role, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  if (!role || !roles.includes(role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
