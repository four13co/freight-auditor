import type { FormEvent } from 'react';
import { HEX_COLOR_PATTERN, type BrandingFieldErrors } from '../lib/validation.js';

export type BrandingSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface DomainFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

interface BrandingFormProps {
  testIdPrefix: string;
  /** Overrides the default `${testIdPrefix}-error` testid on the save-failed banner. */
  errorTestId?: string;
  domain?: DomainFieldProps;
  logoUrl: string;
  onLogoUrlChange: (value: string) => void;
  primaryColor: string;
  onPrimaryColorChange: (value: string) => void;
  secondaryColor: string;
  onSecondaryColorChange: (value: string) => void;
  errors: BrandingFieldErrors;
  saveStatus: BrandingSaveStatus;
  submitLabel: string;
  onSubmit: (e: FormEvent) => void;
}

/**
 * Shared branding form (logo/primary/secondary color, optional domain) used
 * by both the internal analyst Settings page and a tenant's Branding tab.
 * Presentational only -- callers own field state, validation, and submit.
 */
export function BrandingForm({
  testIdPrefix,
  errorTestId,
  domain,
  logoUrl,
  onLogoUrlChange,
  primaryColor,
  onPrimaryColorChange,
  secondaryColor,
  onSecondaryColorChange,
  errors,
  saveStatus,
  submitLabel,
  onSubmit,
}: BrandingFormProps) {
  return (
    <form
      data-testid={`${testIdPrefix}-form`}
      onSubmit={onSubmit}
      className="flex max-w-md flex-col gap-4 px-5"
    >
      {domain && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${testIdPrefix}-domain`} className="text-[13px] font-semibold text-[#201e1d]">
            Domain
          </label>
          <input
            id={`${testIdPrefix}-domain`}
            aria-label="Domain"
            value={domain.value}
            onChange={(e) => domain.onChange(e.target.value)}
            disabled={domain.disabled}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none disabled:opacity-60"
          />
          {errors.domain && (
            <span data-testid={`${testIdPrefix}-domain-error`} role="alert" className="text-[12px] text-[#c0290f]">
              {errors.domain}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${testIdPrefix}-logo-url`} className="text-[13px] font-semibold text-[#201e1d]">
          Logo URL
        </label>
        <input
          id={`${testIdPrefix}-logo-url`}
          aria-label="Logo URL"
          value={logoUrl}
          onChange={(e) => onLogoUrlChange(e.target.value)}
          placeholder="https://cdn.example.com/logo.png"
          className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
        />
        {errors.logoUrl && (
          <span data-testid={`${testIdPrefix}-logo-url-error`} role="alert" className="text-[12px] text-[#c0290f]">
            {errors.logoUrl}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${testIdPrefix}-primary-color`} className="text-[13px] font-semibold text-[#201e1d]">
          Primary color
        </label>
        <div className="flex items-center gap-2">
          <span
            data-testid={`${testIdPrefix}-primary-color-swatch`}
            className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]"
            style={{ background: HEX_COLOR_PATTERN.test(primaryColor) ? primaryColor : 'transparent' }}
          />
          <input
            id={`${testIdPrefix}-primary-color`}
            aria-label="Primary color"
            value={primaryColor}
            onChange={(e) => onPrimaryColorChange(e.target.value)}
            placeholder="#112233"
            className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        {errors.primaryColor && (
          <span data-testid={`${testIdPrefix}-primary-color-error`} role="alert" className="text-[12px] text-[#c0290f]">
            {errors.primaryColor}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${testIdPrefix}-secondary-color`} className="text-[13px] font-semibold text-[#201e1d]">
          Secondary color
        </label>
        <div className="flex items-center gap-2">
          <span
            data-testid={`${testIdPrefix}-secondary-color-swatch`}
            className="h-6 w-6 flex-none border border-[rgba(32,30,29,0.3)]"
            style={{ background: HEX_COLOR_PATTERN.test(secondaryColor) ? secondaryColor : 'transparent' }}
          />
          <input
            id={`${testIdPrefix}-secondary-color`}
            aria-label="Secondary color"
            value={secondaryColor}
            onChange={(e) => onSecondaryColorChange(e.target.value)}
            placeholder="#445566 (optional)"
            className="h-9 flex-1 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
          />
        </div>
        {errors.secondaryColor && (
          <span data-testid={`${testIdPrefix}-secondary-color-error`} role="alert" className="text-[12px] text-[#c0290f]">
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
          {saveStatus === 'saving' ? 'Saving…' : submitLabel}
        </button>
        {saveStatus === 'saved' && (
          <span data-testid={`${testIdPrefix}-saved`} role="status" className="text-[13px] font-semibold text-[#1a7f37]">
            Saved
          </span>
        )}
        {saveStatus === 'error' && (
          <span data-testid={errorTestId ?? `${testIdPrefix}-error`} role="alert" className="text-[13px] font-semibold text-[#c0290f]">
            Save failed. Try again.
          </span>
        )}
      </div>
    </form>
  );
}
