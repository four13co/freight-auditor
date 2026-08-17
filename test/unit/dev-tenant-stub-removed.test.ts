import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

describe('dev-tenant-stub is fully removed (86e2v24zj)', () => {
  it('the file no longer exists', () => {
    expect(existsSync('src/modules/findings/dev-tenant-stub.ts')).toBe(false);
  });

  it('nothing in src/ references the dead export', () => {
    const output = execSync('grep -rn "resolveDevTenantContext" src/ || true', {
      encoding: 'utf-8',
    });
    expect(output.trim()).toBe('');
  });
});
