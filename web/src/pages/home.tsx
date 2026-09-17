import { Button } from '@/components/ui/button';
import { ModeToggle } from '@/components/mode-toggle';
import { APP_NAME } from '@/lib/app-info';
import { useAuth } from '@/providers/auth-provider';
import ThemeSmokeTest from '@/pages/theme-smoke-test';

/**
 * Placeholder authenticated home -- role-specific content is 86e3a6rbe
 * (Employee home screen) and 86e3a6rgc (Client home screen). This is the
 * "/" route every role currently lands on after login.
 */
export default function HomePage() {
  const { user, logout } = useAuth();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          {user && (
            <p className="text-sm text-muted-foreground">
              Signed in as {user.name ?? user.email ?? user.id} ({user.role})
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void logout()}>
            Log out
          </Button>
          <ModeToggle />
        </div>
      </div>

      <ThemeSmokeTest />
    </main>
  );
}
