import { useState } from 'react';
import { authClient } from '../lib/auth-client.js';
import { devHeaderPathActive } from '../App.js';

/**
 * 86e2v1bf1: "register a passkey" affordance for an already-logged-in user
 * -- additive to the email/password baseline (86e2v1bdj), never a
 * replacement (No-gos). Deliberately minimal: one button, one status line,
 * no passkey list/management UI beyond what better-auth's client provides
 * out of the box (No-gos also rules out cross-device sync UI).
 *
 * Renders nothing on the dev-header path (App.tsx's devHeaderPathActive()):
 * that path never authenticates a real better-auth session (Dashboard
 * renders unconditionally there), so there's no real session for a passkey
 * to attach to -- the button would just error on click. Reuses App.tsx's
 * own gate rather than a second copy, per that file's own "these gates must
 * stay coherent" note; Header.tsx already sets this repo's precedent for
 * why a non-functional control must not render as if it works.
 */
export function PasskeyRegistration() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (devHeaderPathActive()) return null;

  async function handleRegister() {
    setStatus('pending');
    setError(null);
    const { error: registerError } = await authClient.passkey.addPasskey();
    if (registerError) {
      setStatus('error');
      setError(registerError.message ?? 'Could not register a passkey');
      return;
    }
    setStatus('done');
  }

  return (
    <div className="flex items-center gap-2.5 border-b border-[rgba(32,30,29,0.15)] px-6 py-2 text-[13px]">
      <button
        type="button"
        onClick={handleRegister}
        disabled={status === 'pending'}
        className="h-8 border border-[rgba(32,30,29,0.4)] px-3 text-[13px] font-extrabold text-[#201e1d] disabled:opacity-60"
      >
        {status === 'pending' ? 'Registering…' : 'Register a passkey'}
      </button>
      {status === 'done' && <span className="text-[rgba(32,30,29,0.75)]">Passkey registered.</span>}
      {status === 'error' && error && (
        <span role="alert" className="font-bold text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}
