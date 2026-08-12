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

    it('does not leak the raw connection string (with embedded password) in the thrown message (86e2t15ka AC2)', () => {
      const malformedUrlWithPassword = 'not a valid url but has a secretpassword123 in it';
      try {
        extractHost(malformedUrlWithPassword);
        expect.unreachable('expected extractHost to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain('secretpassword123');
        expect((err as Error).message).not.toContain(malformedUrlWithPassword);
      }
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
