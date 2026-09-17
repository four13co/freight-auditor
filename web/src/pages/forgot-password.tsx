import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { requestPasswordReset } from '@/lib/auth-client';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 86e3a6r6n: better-auth's emailAndPassword.sendResetPassword isn't
 * configured yet (src/auth/better-auth.ts), so requestPasswordReset()
 * currently rejects with a BAD_REQUEST ("Reset password isn't enabled")
 * regardless of whether the email matches an account. That's folded into
 * the same generic confirmation as a real send below -- which is also the
 * correct behavior once the backend is wired up (never reveal account
 * existence). Only a genuine network failure (the request itself never
 * completing) surfaces as an error.
 */
export default function ForgotPasswordPage() {
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
    try {
      await requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } catch {
      setSubmitting(false);
      setError('Something went wrong. Check your connection and try again.');
      return;
    }
    setSubmitting(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            If an account with that email exists, we've sent a link to reset your password.
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
        <h1 className="text-lg font-semibold tracking-tight">Forgot your password?</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we'll send you a link to reset it.
        </p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="forgot-password-email">Email</Label>
          <Input
            id="forgot-password-email"
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
          Send reset link
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
