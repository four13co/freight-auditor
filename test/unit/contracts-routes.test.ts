import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

function mockAuth() {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { clientIds: ['11111111-1111-4111-8111-111111111111'] };
        request.actorUserId = '22222222-2222-4222-8222-222222222222';
      });
    },
  }));
}

describe('contract upload routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  async function setup(result = { contractId: 'c1', contractVersionId: 'v1', sourceDocumentId: 's1', sha256: 'abc', created: true }) {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const uploadContractDocument = vi.fn().mockResolvedValue(result);
    const uploadContractVersionDocument = vi.fn().mockResolvedValue(result);
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', async (original) => ({
      ...(await original()), uploadContractDocument, uploadContractVersionDocument,
    }));
    vi.doMock('../../src/modules/reference-data/configured-object-store.js', () => ({ configuredObjectStore: () => ({}) }));
    const finalizeContractVersion = vi.fn().mockResolvedValue({ id: 'verified', verificationHash: 'a'.repeat(64), fieldCount: 2, created: true });
    vi.doMock('../../src/modules/contracts/finalize-contract-version.js', () => ({ finalizeContractVersion }));
    const { registerContractsRoutes } = await import('../../src/server/contracts-routes.js');
    app = Fastify();
    await app.register(registerContractsRoutes);
    await app.ready();
    return { uploadContractDocument, uploadContractVersionDocument, finalizeContractVersion };
  }

  it('creates a contract and initial immutable version from a PDF', async () => {
    const calls = await setup();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/contracts?carrier_id=33333333-3333-4333-8333-333333333333&name=Primary&version_label=v1&valid_from=2026-01-01',
      headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('pdf'),
    });
    expect(response.statusCode).toBe(201);
    expect(calls.uploadContractDocument).toHaveBeenCalledWith({}, expect.anything(), expect.objectContaining({
      clientId: '11111111-1111-4111-8111-111111111111', actorUserId: '22222222-2222-4222-8222-222222222222',
      metadata: expect.objectContaining({ name: 'Primary', validFrom: '2026-01-01' }),
    }));
  });

  it('returns 200 for an idempotent retry', async () => {
    await setup({ contractId: 'c1', contractVersionId: 'v1', sourceDocumentId: 's1', sha256: 'abc', created: false });
    const response = await app!.inject({
      method: 'POST',
      url: '/api/contracts?carrier_id=33333333-3333-4333-8333-333333333333&name=Primary&valid_from=2026-01-01',
      headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('same'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(false);
  });

  it('rejects invalid dates before touching persistence', async () => {
    const calls = await setup();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/contracts?carrier_id=33333333-3333-4333-8333-333333333333&name=Primary&valid_from=2026-02-01&valid_to=2026-01-01',
      headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('pdf'),
    });
    expect(response.statusCode).toBe(400);
    expect(calls.uploadContractDocument).not.toHaveBeenCalled();
  });

  it('rejects a malformed contract id on version upload', async () => {
    const calls = await setup();
    const response = await app!.inject({
      method: 'POST', url: '/api/contracts/not-a-uuid/versions?valid_from=2026-01-01',
      headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('pdf'),
    });
    expect(response.statusCode).toBe(400);
    expect(calls.uploadContractVersionDocument).not.toHaveBeenCalled();
  });

  it('finalizes a verified contract version with the pinned extraction hash', async () => {
    const calls = await setup();
    const id = '33333333-3333-4333-8333-333333333333';
    const response = await app!.inject({ method: 'POST', url: `/api/contract-versions/${id}/finalize`,
      payload: { extraction_response_hash: 'a'.repeat(64) } });
    expect(response.statusCode).toBe(201);
    expect(calls.finalizeContractVersion).toHaveBeenCalledWith({}, {
      clientId: '11111111-1111-4111-8111-111111111111', contractVersionId: id,
      actorUserId: '22222222-2222-4222-8222-222222222222', extractionResponseHash: 'a'.repeat(64),
    });
  });

  it('rejects malformed finalization evidence before persistence', async () => {
    const calls = await setup();
    const response = await app!.inject({ method: 'POST', url: '/api/contract-versions/not-a-uuid/finalize', payload: {} });
    expect(response.statusCode).toBe(400); expect(calls.finalizeContractVersion).not.toHaveBeenCalled();
  });
});
