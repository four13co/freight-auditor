import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { isPaymentAuthorizationAction, type PaymentAuthorizationAction } from '../modules/payments/payment-authorization-action.js';
import { authorizePayment, AuthorizePaymentError } from '../modules/payments/authorize-payment.js';
import { listPendingPaymentAuthorizations } from '../modules/payments/list-pending-payment-authorizations.js';

/**
 * Payment authorization APIs (P4.B.5) plus the analyst payment-approval
 * queue read (P4.B.6): an analyst approves or holds an audit run's payment.
 * Encapsulated so registerTenantAuthPreHandler binds ONLY to this plugin
 * instance -- registering it at the app level would also gate /health
 * (findings-routes.ts's own precedent/warning).
 *
 * Deliberately excludes do_not_pay (system-generated, P4.B.4) and any read
 * against client_payment_policy (that table is on #161, unmerged, and
 * policy-gated enforcement is P4.B.2's boundary, not this one's).
 */
export async function registerPaymentRoutes(paymentRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(paymentRoutes);

  // P4.B.6: the queue an analyst's payment-approval UI renders -- audit
  // runs still on the default 'hold' with no resolving decision yet. GET,
  // read-only, no id in the path (a collection, unlike the POST below which
  // acts on one audit run) -- mirrors /api/findings/queues and
  // /api/gate-failures' shape (findings-routes.ts).
  paymentRoutes.get('/api/payment-authorizations/pending', async (request) => {
    const pending = await withTenantTx(request.tenantContext!, (client) => listPendingPaymentAuthorizations(client));
    return { pending };
  });

  paymentRoutes.post('/api/audit-runs/:id/payment-authorization', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action?: unknown; rationale?: unknown };

    if (!isUuid(id)) {
      await reply.code(400).send({ error: 'invalid audit run id: must be a well-formed UUID' });
      return;
    }
    if (!isPaymentAuthorizationAction(body.action)) {
      await reply.code(400).send({ error: 'invalid action: must be approve or hold' });
      return;
    }
    if (body.rationale !== undefined && typeof body.rationale !== 'string') {
      await reply.code(400).send({ error: 'invalid rationale: must be a string' });
      return;
    }
    if (!request.actorUserId) {
      await reply.code(401).send({ error: 'authenticated analyst identity required' });
      return;
    }
    const clientId = request.tenantContext!.clientIds?.[0];
    if (!clientId) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    try {
      const result = await withTenantTx(request.tenantContext!, (client) =>
        authorizePayment(client, {
          clientId,
          auditRunId: id,
          action: body.action as PaymentAuthorizationAction,
          rationale: body.rationale as string | undefined,
          actorUserId: request.actorUserId!,
        }),
      );
      reply.code(result.created ? 201 : 200);
      return { auditRunId: id, action: result.action, decisionId: result.decisionId };
    } catch (error) {
      if (error instanceof AuthorizePaymentError) {
        await reply.code(404).send({ error: 'audit run not found' });
        return;
      }
      throw error;
    }
  });
}
