export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 86e39qa6v: the logoUrl/primaryColor/secondaryColor validation block was
 * defined identically 3x server-side (internal-branding-routes.ts, and both
 * the create- and update-branding handlers in tenant-admin-routes.ts).
 * Returns the first validation error message, or null if `body` is a valid
 * branding payload.
 */
export function validateBrandingFields(body: {
  logoUrl?: unknown;
  primaryColor?: unknown;
  secondaryColor?: unknown;
}): string | null {
  if (typeof body.logoUrl !== 'string' || !isValidHttpUrl(body.logoUrl)) {
    return 'invalid logoUrl: must be a valid http(s) URL';
  }
  if (typeof body.primaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.primaryColor)) {
    return 'invalid primaryColor: must be a hex color like #112233';
  }
  if (
    body.secondaryColor !== undefined &&
    body.secondaryColor !== null &&
    (typeof body.secondaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.secondaryColor))
  ) {
    return 'invalid secondaryColor: must be a hex color like #112233, or null';
  }
  return null;
}
