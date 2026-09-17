import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { resetPassword } from '@/lib/auth-client';

// better-auth's default emailAndPassword.minPasswordLength (not overridden
// in src/auth/better-auth.ts) -- see node_modules/better-auth's
// context/create-context.mjs. Update here if that config ever changes.
const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Reset link invalid or expired</h1>
          <p className="text-sm text-muted-foreground">
            This password reset link is missing or no longer valid.
          </p>
        </div>
        <Link to="/forgot-password" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          Request a new reset
        </Link>
      </div>
    );
  }

  if (succeeded) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Password updated</h1>
          <p className="text-sm text-muted-foreground">You can now sign in with your new password.</p>
        </div>
        <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: resetError } = await resetPassword({ newPassword, token: token! });
      if (resetError) {
        setError(
          resetError.status === 400 && /token/i.test(resetError.message ?? '')
            ? 'This reset link has expired or already been used.'
            : (resetError.message ?? 'Something went wrong. Please try again.'),
        );
        return;
      }
      setSucceeded(true);
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Set a new password</h1>
        <p className="text-sm text-muted-foreground">Choose a new password for your account.</p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="reset-new-password">New password</Label>
          <Input
            id="reset-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(error) || undefined}
          />
          <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reset-confirm-password">Confirm password</Label>
          <Input
            id="reset-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
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
          Update password
        </Button>
      </form>
    </div>
  );
}
