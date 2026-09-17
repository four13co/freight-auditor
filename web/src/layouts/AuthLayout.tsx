import { Outlet } from 'react-router-dom';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { APP_NAME } from '@/lib/app-info';

/**
 * Shared shell for every unauthenticated page (/login, /forgot-username,
 * /reset-password). The wordmark is plain text -- swap for an <img>/SVG
 * logo later without touching layout structure (AC: "easy to swap out").
 */
export default function AuthLayout() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/40 p-4">
      <div className="w-full max-w-[400px]">
        <Card className="shadow-lg">
          <CardHeader className="items-center text-center">
            <span className="text-lg font-semibold tracking-tight">{APP_NAME}</span>
          </CardHeader>
          <CardContent>
            <Outlet />
          </CardContent>
        </Card>

        <footer className="mt-6 flex justify-center gap-4 text-xs text-muted-foreground">
          <span>&copy; {new Date().getFullYear()} {APP_NAME}</span>
          <a href="/privacy" className="hover:underline">
            Privacy
          </a>
          <a href="/terms" className="hover:underline">
            Terms
          </a>
        </footer>
      </div>
    </main>
  );
}
