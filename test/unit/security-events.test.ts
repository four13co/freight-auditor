import { describe, expect, it, vi } from 'vitest';

const { withTenantTx } = vi.hoisted(() => ({
  withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({ query: vi.fn().mockResolvedValue({ rows: [{ id: 'x', created: true }] }) })),
}));
vi.mock('../../src/db/tenant-context.js', () => ({ withTenantTx }));

import { authenticationAction, writeSecurityEvent } from '../../src/modules/audit-ledger/security-events.js';

describe('security audit events', () => {
  it('allowlists authentication mutations and ignores credential reads/unknown routes', () => {
    expect(authenticationAction('POST', '/api/auth/sign-in/email')).toBe('sign_in_email');
    expect(authenticationAction('POST', '/api/auth/passkey/add-passkey?x=1')).toBe('passkey_add');
    expect(authenticationAction('GET', '/api/auth/get-session')).toBeNull();
    expect(authenticationAction('POST', '/api/auth/unknown')).toBeNull();
  });

  it('writes through an internal transaction without accepting credential fields', async () => {
    await writeSecurityEvent({
      request: { id: 'request-1' },
      event: 'authentication.sign_in_email.failed',
      detail: { httpStatus: 401 },
    });
    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
  });
});
