import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ROLE_HOME_PATH, useAuth } from '@/providers/auth-provider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const { login, isAuthenticated, isLoading, role } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [justSignedIn, setJustSignedIn] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Waits for role to resolve (it's fetched asynchronously after sign-in
  // succeeds) before redirecting, rather than racing it.
  useEffect(() => {
    if (justSignedIn && !isLoading && isAuthenticated && role) {
      navigate(ROLE_HOME_PATH[role], { replace: true });
    }
  }, [justSignedIn, isLoading, isAuthenticated, role, navigate]);

  if (!isLoading && isAuthenticated && !justSignedIn) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    setSubmitError(null);

    if (!email.trim() || !password) {
      setValidationError('Email and password are required.');
      return;
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      setValidationError('Enter a valid email address.');
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await login(email.trim(), password);
      if (error) {
        setSubmitError(error);
        return;
      }
      setJustSignedIn(true);
    } catch {
      setSubmitError('Something went wrong. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const formError = validationError ?? submitError;

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">Enter your credentials to continue.</p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(formError) || undefined}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="login-password">Password</Label>
          <InputGroup>
            <InputGroupInput
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={Boolean(formError) || undefined}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="login-remember"
            checked={rememberMe}
            onCheckedChange={(checked) => setRememberMe(checked)}
            disabled={submitting}
          />
          <Label htmlFor="login-remember" className="font-normal">
            Remember me
          </Label>
        </div>

        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          Sign in
        </Button>
      </form>

      <div className="flex flex-col items-center gap-1.5 text-sm">
        <Link to="/forgot-username" className="text-muted-foreground hover:text-foreground hover:underline">
          Forgot your username?
        </Link>
        <Link to="/forgot-password" className="text-muted-foreground hover:text-foreground hover:underline">
          Forgot your password?
        </Link>
      </div>
    </div>
  );
}
