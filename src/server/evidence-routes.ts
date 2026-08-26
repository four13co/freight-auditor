import type { FastifyInstance, FastifyReply } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { getDefensibilityChain } from '../modules/findings/get-defensibility-chain.js';
import { getInvoiceScorecard, getReplayManifest, getRubricSnapshot, listResolutionConflicts } from '../modules/audit-ledger/read-audit-evidence.js';

const validId = async (id: string, reply: FastifyReply): Promise<boolean> => {
  if (isUuid(id)) return true;
  await reply.code(400).send({ error: 'invalid id: must be a well-formed UUID' });
  return false;
};

export async function registerEvidenceRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);
  routes.get('/api/findings/:id/provenance', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!await validId(id, reply)) return;
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) return reply.code(401).send({ error: 'unauthorized' });
    const chain = await withTenantTx(request.tenantContext!, (client) => getDefensibilityChain(client, clientId, id));
    return chain ?? reply.code(404).send({ error: 'finding not found' });
  });
  routes.get('/api/audit-runs/:id/rubric-snapshot', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!await validId(id, reply)) return;
    const value = await withTenantTx(request.tenantContext!, (client) => getRubricSnapshot(client, id));
    return value ?? reply.code(404).send({ error: 'rubric snapshot not found' });
  });
  routes.get('/api/audit-runs/:id/conflicts', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!await validId(id, reply)) return;
    return { conflicts: await withTenantTx(request.tenantContext!, (client) => listResolutionConflicts(client, id)) };
  });
  routes.get('/api/audit-runs/:id/replay-manifest', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!await validId(id, reply)) return;
    const value = await withTenantTx(request.tenantContext!, (client) => getReplayManifest(client, id));
    return value ?? reply.code(404).send({ error: 'replay manifest not found' });
  });
  routes.get('/api/audit-runs/:id/scorecard', async (request, reply) => {
    const { id } = request.params as { id: string }; if (!await validId(id, reply)) return;
    const value = await withTenantTx(request.tenantContext!, (client) => getInvoiceScorecard(client, id));
    return value ?? reply.code(404).send({ error: 'scorecard not found' });
  });
}
