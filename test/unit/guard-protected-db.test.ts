import { describe, it, expect } from 'vitest';
import { extractHost, isProtectedHost, PROTECTED_DB_HOSTS } from '../../scripts/guard-protected-db.mjs';

describe('guard-protected-db (unit)', () => {
  describe('extractHost', () => {
    it('extracts the hostname from a postgres connection URL', () => {
      expect(extractHost('postgresql://user:pw@127.0.0.1:5432/db')).toBe('127.0.0.1');
    });

    it('throws when the URL cannot be parsed', () => {
      expect(() => extractHost('not-a-url')).toThrow(/Could not parse DATABASE_URL/);
    });
  });

  describe('isProtectedHost', () => {
    it.each(PROTECTED_DB_HOSTS as string[])('rejects %s as a protected host', (host: string) => {
      expect(isProtectedHost(host)).toBe(true);
    });

    it('rejects a subdomain of a protected host', () => {
      expect(isProtectedHost('ep-cool-name-123.us-east-2.aws.neon.tech')).toBe(true);
    });

    it('passes the actual CapRover-hosted DB host', () => {
      expect(isProtectedHost('srv-captain--freight-auditor-db')).toBe(false);
    });

    it('passes a local ephemeral host', () => {
      expect(isProtectedHost('127.0.0.1')).toBe(false);
    });
  });
});
