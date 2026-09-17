import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 86e3a6r6e: no backend endpoint exists for this yet (there's no separate
 * "username" concept in better-auth's email/password setup -- see
 * src/auth/better-auth.ts). Expected contract for whoever builds it:
 *
 *   POST /api/auth/forgot-username
 *   body: { email: string }
 *   response: 200 always (mirrors the security pattern below -- never
 *     signal whether the email matched an account), fire-and-forget email
 *     send on the backend.
 *
 * Until that route exists, the fetch below 404s -- caught and folded into
 * the same generic success state as a real send, which is also the
 * correct behavior for the finished endpoint (never reveal account
 * existence). Only a genuine network failure (fetch itself rejecting)
 * surfaces as an error.
 */
async function submitForgotUsername(email: string): Promise<{ networkError: boolean }> {
  try {
    await fetch('/api/auth/forgot-username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return { networkError: false };
  } catch {
    return { networkError: true };
  }
}

export default function ForgotUsernamePage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!email.trim() || !EMAIL_PATTERN.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }

    setSubmitting(true);
    const { networkError } = await submitForgotUsername(email.trim());
    setSubmitting(false);

    if (networkError) {
      setError('Something went wrong. Check your connection and try again.');
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            If an account with that email exists, we've sent your username.
          </p>
        </div>
        <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Forgot your username?</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we'll send you your username if we find a match.
        </p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="forgot-username-email">Email</Label>
          <Input
            id="forgot-username-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(error) || undefined}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          Send username
        </Button>
      </form>

      <div className="text-center text-sm">
        <Link to="/login" className="text-muted-foreground hover:text-foreground hover:underline">
          Back to login
        </Link>
      </div>
    </div>
  );
}
