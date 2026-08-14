import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { resolveDevTenantContext } from '../../src/modules/findings/dev-tenant-stub.js';

function mockRequest(headerValue: string | string[] | undefined): FastifyRequest {
  return { headers: { 'x-client-id': headerValue } } as unknown as FastifyRequest;
}

describe('resolveDevTenantContext', () => {
  it('resolves a single x-client-id header to that client scope', () => {
    const ctx = resolveDevTenantContext(mockRequest('client-123'));
    expect(ctx).toEqual({ clientIds: ['client-123'], internal: false });
  });

  it('takes the first value when the header is sent multiple times', () => {
    const ctx = resolveDevTenantContext(mockRequest(['client-a', 'client-b']));
    expect(ctx).toEqual({ clientIds: ['client-a'], internal: false });
  });

  it('returns an empty, non-internal scope when the header is absent', () => {
    const ctx = resolveDevTenantContext(mockRequest(undefined));
    expect(ctx).toEqual({ clientIds: [], internal: false });
  });
});
