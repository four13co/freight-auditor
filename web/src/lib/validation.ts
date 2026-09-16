export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface BrandingFieldValues {
  domain?: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
}

export interface BrandingFieldErrors {
  domain?: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

export function validateBrandingFields(
  values: BrandingFieldValues,
  opts: { requireDomain: boolean } = { requireDomain: false },
): BrandingFieldErrors {
  const errors: BrandingFieldErrors = {};
  if (opts.requireDomain && !(values.domain ?? '').trim()) {
    errors.domain = 'Enter a domain.';
  }
  if (!values.logoUrl.trim() || !isValidHttpUrl(values.logoUrl)) {
    errors.logoUrl = 'Enter a valid http(s) URL.';
  }
  if (!values.primaryColor.trim() || !HEX_COLOR_PATTERN.test(values.primaryColor)) {
    errors.primaryColor = 'Enter a valid hex color, e.g. #112233.';
  }
  if (values.secondaryColor.trim() !== '' && !HEX_COLOR_PATTERN.test(values.secondaryColor)) {
    errors.secondaryColor = 'Enter a valid hex color, e.g. #112233, or leave blank.';
  }
  return errors;
}
