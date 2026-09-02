import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerClientViewerAuthPreHandler } from '../modules/identity/client-viewer-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { listClientInvoices } from '../modules/portal/list-client-invoices.js';
import { getClientAuditRunScorecard } from '../modules/portal/get-client-audit-run-scorecard.js';
import { listClientFindings, type ClientFindingsSortKey } from '../modules/portal/list-client-findings.js';
import { getDefensibilityChain } from '../modules/findings/get-defensibility-chain.js';
import { ALL_VARIANCE_STATUSES } from '../shared/variance-status.js';
import { getClientDisputeDetail } from '../modules/portal/get-client-dispute-detail.js';
import { listClientDisputeCommunications } from '../modules/portal/list-client-dispute-communications.js';
import { getClaimDetail } from '../modules/claims/get-claim-detail.js';
import { listClientClaimDocuments } from '../modules/portal/list-client-claim-documents.js';

const MAX_LIMIT = 200;
const VARIANCE_STATUS_VALUES = new Set<string>(ALL_VARIANCE_STATUSES);
// Mirrors findings-routes.ts's own SORT_KEYS/SORT_DIRS allowlists exactly.
const SORT_KEYS = new Set<ClientFindingsSortKey>(['variance', 'age']);
const SORT_DIRS = new Set(['asc', 'desc']);
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/**
 * Client portal content read APIs: invoice list + per-audit-run scorecard
 * (P6.B.1), findings list + finding evidence/defensibility chain (P6.B.2),
 * gated by client-viewer-auth.ts's OWN preHandler
 * (registerClientViewerAuthPreHandler) rather than the shared
 * registerTenantAuthPreHandler every internal-facing route module uses --
 * same reasoning as portfolio-routes.ts's own header comment: this surface
 * must only ever grant access to a `client_viewer` membership, and must
 * reject client_admin/internal roles and any non-GET/HEAD method
 * structurally, before this handler runs. client_viewer-auth.ts's context
 * always resolves a single clientId (never multi-client), so unlike
 * claim-recovery-routes.ts there is no "no single tenant scope" case to
 * reject here.
 *
 * GET /api/portal/scorecard/:auditRunId (not a client-wide summary --
 * see get-client-audit-run-scorecard.ts's own header comment for why)
 * mirrors claim-recovery-routes.ts's GET /api/claims/:id shape exactly:
 * isUuid-validate the param, 404 when the module resolves null.
 *
 * GET /api/portal/findings/:id/evidence reuses getDefensibilityChain
 * as-is (findings/get-defensibility-chain.ts), the exact same function
 * evidence-routes.ts's internal GET /api/findings/:id/provenance already
 * calls with an explicit clientId -- no field-level filtering needed here,
 * since that route already exposes this same shape to a tenant-scoped
 * caller today.
 *
 * GET /api/portal/disputes/:id and GET /api/portal/disputes/:id/communications
 * (P6.B.3) do NOT reuse the internal getDisputeDetail/listDisputeCommunications
 * as-is -- unlike getDefensibilityChain, those rely on RLS alone (no clientId
 * param at all), so new client-scoped wrapper modules
 * (get-client-dispute-detail.ts / list-client-dispute-communications.ts)
 * mirror their join shape with an added explicit client_id predicate,
 * matching this surface's own convention elsewhere.
 *
 * GET /api/portal/disputes/:id/communications 404s on the dispute lookup
 * itself before returning communications, mirroring
 * dispute-review-routes.ts's internal GET /api/disputes/:id/communications
 * exactly.
 *
 * GET /api/portal/claims/:id (P6.B.4) reuses getClaimDetail as-is
 * (modules/claims/get-claim-detail.ts) -- like getDefensibilityChain, it
 * already carries an explicit client_id predicate on both its queries, so
 * no wrapper is needed (unlike the P6.B.3 dispute functions).
 *
 * GET /api/portal/claims/:id/documents (P6.B.4) resolves the claim's
 * evidence documents via a new module, list-client-claim-documents.ts,
 * rather than the existing buildEvidencePacket
 * (modules/disputes/build-evidence-packet.ts) -- that function throws when
 * ANY dispute_line on the claim's originating dispute lacks a
 * variance_finding_id, which would report zero documents for a claim with
 * even one findingless line alongside otherwise-good ones. The new
 * module's direct join drops a findingless (or document-less) line via the
 * JOIN instead -- see its own header comment for the full reasoning.
 *
 * client_admin's equivalent access (P6.A.3, sibling capability) and the
 * portal UI shell/nav that will mount these views (P6.A.1) are explicitly
 * out of this task's boundary -- see this task's own Exclusions.
 */
export async function registerPortalContentRoutes(routes: FastifyInstance): Promise<void> {
  await registerClientViewerAuthPreHandler(routes);

  routes.get('/api/portal/invoices', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const query = request.query as { status?: string; limit?: string; offset?: string };

    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        await reply.code(400).send({ error: `invalid limit: must be an integer between 1 and ${MAX_LIMIT}` });
        return;
      }
    }

    let offset: number | undefined;
    if (query.offset !== undefined) {
      offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        await reply.code(400).send({ error: 'invalid offset: must be a non-negative integer' });
        return;
      }
    }

    const invoices = await withTenantTx(request.tenantContext!, (client) =>
      listClientInvoices(client, clientId, { status: query.status, limit, offset }),
    );
    return { invoices };
  });

  routes.get('/api/portal/scorecard/:auditRunId', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { auditRunId } = request.params as { auditRunId: string };
    if (!isUuid(auditRunId)) {
      await reply.code(400).send({ error: 'invalid audit run id: must be a well-formed UUID' });
      return;
    }

    const scorecard = await withTenantTx(request.tenantContext!, (client) =>
      getClientAuditRunScorecard(client, clientId, auditRunId),
    );
    if (!scorecard) {
      await reply.code(404).send({ error: 'audit run not found' });
      return;
    }
    return scorecard;
  });

  routes.get('/api/portal/findings', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const query = request.query as {
      carrier?: string;
      status?: string;
      'min-amount'?: string;
      sort?: string;
      sortDir?: string;
      limit?: string;
      offset?: string;
    };

    if (query.status !== undefined && !VARIANCE_STATUS_VALUES.has(query.status)) {
      await reply.code(400).send({ error: `invalid status: must be one of ${[...VARIANCE_STATUS_VALUES].join(', ')}` });
      return;
    }
    if (query['min-amount'] !== undefined && !NUMERIC_STRING.test(query['min-amount'])) {
      await reply.code(400).send({ error: 'invalid min-amount: must be numeric' });
      return;
    }
    if (query.sort !== undefined && !SORT_KEYS.has(query.sort as ClientFindingsSortKey)) {
      await reply.code(400).send({ error: `invalid sort: must be one of ${[...SORT_KEYS].join(', ')}` });
      return;
    }
    if (query.sortDir !== undefined && !SORT_DIRS.has(query.sortDir)) {
      await reply.code(400).send({ error: `invalid sortDir: must be one of ${[...SORT_DIRS].join(', ')}` });
      return;
    }

    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        await reply.code(400).send({ error: `invalid limit: must be an integer between 1 and ${MAX_LIMIT}` });
        return;
      }
    }

    let offset: number | undefined;
    if (query.offset !== undefined) {
      offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        await reply.code(400).send({ error: 'invalid offset: must be a non-negative integer' });
        return;
      }
    }

    const findings = await withTenantTx(request.tenantContext!, (client) =>
      listClientFindings(client, clientId, {
        carrier: query.carrier,
        status: query.status,
        minAmount: query['min-amount'],
        sort: query.sort as ClientFindingsSortKey | undefined,
        sortDir: query.sortDir as 'asc' | 'desc' | undefined,
        limit,
        offset,
      }),
    );
    return { findings };
  });

  routes.get('/api/portal/findings/:id/evidence', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid finding id: must be a well-formed UUID' });
      return;
    }

    const chain = await withTenantTx(request.tenantContext!, (client) =>
      getDefensibilityChain(client, clientId, id),
    );
    if (!chain) {
      await reply.code(404).send({ error: 'finding not found' });
      return;
    }
    return chain;
  });

  routes.get('/api/portal/disputes/:id', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }

    const detail = await withTenantTx(request.tenantContext!, (client) =>
      getClientDisputeDetail(client, clientId, id),
    );
    if (!detail) {
      await reply.code(404).send({ error: 'dispute not found' });
      return;
    }
    return detail;
  });

  routes.get('/api/portal/disputes/:id/communications', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid dispute id: must be a well-formed UUID' });
      return;
    }

    const detail = await withTenantTx(request.tenantContext!, (client) =>
      getClientDisputeDetail(client, clientId, id),
    );
    if (!detail) {
      await reply.code(404).send({ error: 'dispute not found' });
      return;
    }

    const communications = await withTenantTx(request.tenantContext!, (client) =>
      listClientDisputeCommunications(client, clientId, id),
    );
    return { communications };
  });

  routes.get('/api/portal/claims/:id', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid claim id: must be a well-formed UUID' });
      return;
    }

    const detail = await withTenantTx(request.tenantContext!, (client) =>
      getClaimDetail(client, clientId, id),
    );
    if (!detail) {
      await reply.code(404).send({ error: 'claim not found' });
      return;
    }
    return detail;
  });

  routes.get('/api/portal/claims/:id/documents', async (request, reply) => {
    const clientId = request.tenantContext!.clientIds![0]!;

    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid claim id: must be a well-formed UUID' });
      return;
    }

    const documents = await withTenantTx(request.tenantContext!, (client) =>
      listClientClaimDocuments(client, clientId, id),
    );
    if (!documents) {
      await reply.code(404).send({ error: 'claim not found' });
      return;
    }
    return { documents };
  });
}
