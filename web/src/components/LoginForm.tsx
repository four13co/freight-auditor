import { useState, type FormEvent } from 'react';
import { signIn } from '../lib/auth-client.js';

/**
 * 86e2v1bdj: a bare email/password login form -- the item's stated appetite
 * (S) is a bare form, expanded only if better-auth's minimal client setup
 * leaves no smaller working slice. Password reset / email verification are
 * explicit Rabbit holes this item does not build.
 *
 * 86e2v1bf1: passkey sign-in is additive, alongside this form -- the
 * email/password path below is completely unmodified (No-gos: this must
 * never become the only auth method, and must keep working if passkey auth
 * fails or is unavailable).
 */
export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error: signInError } = await signIn.email({ email, password });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? 'Invalid email or password');
    }
  }

  async function handlePasskeySignIn() {
    setPasskeyPending(true);
    setPasskeyError(null);
    const result = await signIn.passkey();
    setPasskeyPending(false);
    if (result?.error) {
      setPasskeyError(result.error.message ?? 'Passkey sign-in failed');
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#f8f4f4]">
      <form
        onSubmit={handleSubmit}
        className="flex w-[340px] flex-col gap-4 border border-[rgba(32,30,29,0.4)] bg-white p-8"
      >
        <h1 className="text-[17px] font-extrabold tracking-[-0.015em] text-[#201e1d]">Sign in</h1>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-[#201e1d]">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-3 text-[13px] text-[#201e1d]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-[#201e1d]">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-3 text-[13px] text-[#201e1d]"
          />
        </label>
        {error && (
          <p role="alert" className="text-[13px] font-bold text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="h-9 bg-[#201e1d] px-3.5 text-sm font-extrabold text-white disabled:opacity-60"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        {passkeyError && (
          <p role="alert" className="text-[13px] font-bold text-red-700">
            {passkeyError}
          </p>
        )}
        <button
          type="button"
          onClick={handlePasskeySignIn}
          disabled={passkeyPending}
          className="h-9 border border-[rgba(32,30,29,0.4)] px-3.5 text-sm font-extrabold text-[#201e1d] disabled:opacity-60"
        >
          {passkeyPending ? 'Signing in…' : 'Sign in with a passkey'}
        </button>
      </form>
    </div>
  );
}
