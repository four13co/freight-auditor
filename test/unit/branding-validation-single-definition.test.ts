import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e39qa6v: HEX_COLOR_PATTERN, isValidHttpUrl, and the
 * logoUrl/primaryColor/secondaryColor validation block were defined 3x
 * server-side (internal-branding-routes.ts, and both the create- and
 * update-branding handlers within tenant-admin-routes.ts itself). Only
 * src/shared/request-validation.ts should define them now; every server
 * call site imports from there instead. Mirrors
 * read-header-single-definition.test.ts's structure.
 */
describe('branding validation helpers have a single definition', () => {
  const CANONICAL = 'src/shared/request-validation.ts';
  const routeFiles = ['src/server/internal-branding-routes.ts', 'src/server/tenant-admin-routes.ts'];

  it('HEX_COLOR_PATTERN is defined only in request-validation.ts', () => {
    const files = [CANONICAL, ...routeFiles];
    const definers = files.filter((f) => /HEX_COLOR_PATTERN\s*=/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(definers).toEqual([CANONICAL]);
  });

  it('isValidHttpUrl is defined only in request-validation.ts', () => {
    const files = [CANONICAL, ...routeFiles, 'src/server/profile-routes.ts'];
    const definers = files.filter((f) => /function isValidHttpUrl\(/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(definers).toEqual([CANONICAL]);
  });

  it('validateBrandingFields is defined only in request-validation.ts', () => {
    const files = [CANONICAL, ...routeFiles];
    const definers = files.filter((f) => /function validateBrandingFields\(/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(definers).toEqual([CANONICAL]);
  });

  it('internal-branding-routes.ts and tenant-admin-routes.ts import validateBrandingFields from request-validation.js', () => {
    for (const f of routeFiles) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\bvalidateBrandingFields\b[^}]*\}\s*from\s*['"][^'"]*request-validation\.js['"]/);
    }
  });

  it('profile-routes.ts imports isValidHttpUrl from request-validation.js', () => {
    const content = readFileSync(join(ROOT, 'src/server/profile-routes.ts'), 'utf8');
    expect(content).toMatch(/import\s*\{[^}]*\bisValidHttpUrl\b[^}]*\}\s*from\s*['"][^'"]*request-validation\.js['"]/);
  });

  it('no route file re-declares the primaryColor hex-check inline (catches a drifted-copy reintroduction)', () => {
    for (const f of routeFiles) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).not.toMatch(/primaryColor.*HEX_COLOR_PATTERN\.test/);
    }
  });
});
