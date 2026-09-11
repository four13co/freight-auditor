import { useEffect, useState, type FormEvent } from 'react';
import { fetchBranding, updateBranding } from '../lib/api.js';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type LoadStatus = 'loading' | 'ready';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface FieldErrors {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

/**
 * 86e37r2t4: internal-analyst-facing Settings page -- narrowly scoped to the
 * one settings surface with a real table behind it (customer_branding).
 * Pre-fills from the existing (unauthenticated) fetchBranding() call, same
 * as App.tsx/BrandMark.tsx already do, and submits to the new
 * PATCH /api/internal/branding. All three validations run client-side
 * before any request is sent (AC3) -- a blank secondaryColor is valid
 * (clears it, sent as null); logoUrl and primaryColor are required.
 *
 * No load-error state: fetchBranding() (lib/api.ts) fails closed to
 * `UNBRANDED` on any fetch error rather than rejecting -- the same contract
 * App.tsx/BrandMark.tsx already rely on for the login-page render. This
 * form therefore only ever sees a resolved (possibly blank) branding value,
 * never a rejected promise.
 */
export function SettingsView() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [logoUrl, setLogoUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [secondaryColor, setSecondaryColor] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  function load() {
    setStatus('loading');
    void fetchBranding().then((branding) => {
      setLogoUrl(branding.logoUrl ?? '');
      setPrimaryColor(branding.primaryColor ?? '');
      setSecondaryColor(branding.secondaryColor ?? '');
      setStatus('ready');
    });
  }

  useEffect(() => {
    load();
  }, []);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!logoUrl.trim() || !isValidHttpUrl(logoUrl)) {
      next.logoUrl = 'Enter a valid http(s) URL.';
    }
    if (!primaryColor.trim() || !HEX_COLOR_PATTERN.test(primaryColor)) {
      next.primaryColor = 'Enter a valid hex color, e.g. #112233.';
    }
    if (secondaryColor.trim() !== '' && !HEX_COLOR_PATTERN.test(secondaryColor)) {
      next.secondaryColor = 'Enter a valid hex color, e.g. #112233, or leave blank.';
    }
    return next;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const fieldErrors = validate();
    setErrors(fieldErrors);
    // AC3: an invalid field rejects client-side with no request sent at all.
    if (Object.keys(fieldErrors).length > 0) return;

    setSaveStatus('saving');
    try {
      const saved = await updateBranding({
        logoUrl,
        primaryColor,
        secondaryColor: secondaryColor.trim() === '' ? null : secondaryColor,
      });
      setLogoUrl(saved.logoUrl);
      setPrimaryColor(saved.primaryColor);
      setSecondaryColor(saved.secondaryColor ?? '');
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Settings</span>
      </div>

      {status === 'loading' && (
        <div data-testid="settings-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {status === 'ready' && (
        <form
          data-testid="settings-form"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="flex max-w-md flex-col gap-4 px-5"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-logo-url" className="text-[13px] font-semibold text-[#201e1d]">
              Logo URL
            </label>
            <input
              id="settings-logo-url"
              aria-label="Logo URL"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://cdn.example.com/logo.png"
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
            {errors.logoUrl && (
              <span data-testid="settings-logo-url-error" role="alert" className="text-[12px] text-[#c0290f]">
                {errors.logoUrl}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-primary-color" className="text-[13px] font-semibold text-[#201e1d]">
              Primary color
            </label>
            <div className="flex items-center gap-2">
              <span
                data-testid="settings-primary-color-swatch"
                className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]"
                style={{ background: HEX_COLOR_PATTERN.test(primaryColor) ? primaryColor : 'transparent' }}
              />
              <input
                id="settings-primary-color"
                aria-label="Primary color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                placeholder="#112233"
                className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
              />
            </div>
            {errors.primaryColor && (
              <span data-testid="settings-primary-color-error" role="alert" className="text-[12px] text-[#c0290f]">
                {errors.primaryColor}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-secondary-color" className="text-[13px] font-semibold text-[#201e1d]">
              Secondary color
            </label>
            <div className="flex items-center gap-2">
              <span
                data-testid="settings-secondary-color-swatch"
                className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]"
                style={{ background: HEX_COLOR_PATTERN.test(secondaryColor) ? secondaryColor : 'transparent' }}
              />
              <input
                id="settings-secondary-color"
                aria-label="Secondary color"
                value={secondaryColor}
                onChange={(e) => setSecondaryColor(e.target.value)}
                placeholder="#445566 (optional)"
                className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
              />
            </div>
            {errors.secondaryColor && (
              <span data-testid="settings-secondary-color-error" role="alert" className="text-[12px] text-[#c0290f]">
                {errors.secondaryColor}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saveStatus === 'saving'}
              className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60"
            >
              {saveStatus === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {saveStatus === 'saved' && (
              <span data-testid="settings-saved" role="status" className="text-[13px] font-semibold text-[#1a7f37]">
                Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span data-testid="settings-save-error" role="alert" className="text-[13px] font-semibold text-[#c0290f]">
                Save failed. Try again.
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
