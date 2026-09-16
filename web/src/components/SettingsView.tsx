import { useEffect, useState, type FormEvent } from 'react';
import { fetchBranding, updateBranding } from '../lib/api.js';
import { validateBrandingFields, type BrandingFieldErrors } from '../lib/validation.js';
import { BrandingForm, type BrandingSaveStatus } from './BrandingForm.js';

type LoadStatus = 'loading' | 'ready';

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
  const [errors, setErrors] = useState<BrandingFieldErrors>({});
  const [saveStatus, setSaveStatus] = useState<BrandingSaveStatus>('idle');

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const fieldErrors = validateBrandingFields({ logoUrl, primaryColor, secondaryColor });
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
        <BrandingForm
          testIdPrefix="settings"
          errorTestId="settings-save-error"
          logoUrl={logoUrl}
          onLogoUrlChange={setLogoUrl}
          primaryColor={primaryColor}
          onPrimaryColorChange={setPrimaryColor}
          secondaryColor={secondaryColor}
          onSecondaryColorChange={setSecondaryColor}
          errors={errors}
          saveStatus={saveStatus}
          submitLabel="Save"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        />
      )}
    </div>
  );
}
