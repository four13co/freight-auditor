import { ModeToggle } from '@/components/mode-toggle';
import { useAuth } from '@/providers/auth-provider';
import ThemeSmokeTest from '@/pages/theme-smoke-test';

/**
 * Placeholder authenticated home -- role-specific content is 86e3a6rbe
 * (Employee home screen) and 86e3a6rgc (Client home screen). Rendered
 * through AppLayout's <Outlet /> (86e3a6r8z), which now owns the page-level
 * <main> landmark, app name, and logout -- this is content only, same
 * pattern as theme-smoke-test.tsx below it.
 */
export default function HomePage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        {user && (
          <p className="text-sm text-muted-foreground">
            Signed in as {user.name ?? user.email ?? user.id} ({user.role})
          </p>
        )}
        <ModeToggle />
      </div>

      <ThemeSmokeTest />
    </div>
  );
}
