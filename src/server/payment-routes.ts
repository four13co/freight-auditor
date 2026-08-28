import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { isUuid } from '../shared/request-validation.js';
import { isPaymentAuthorizationAction, type PaymentAuthorizationAction } from '../modules/payments/payment-authorization-action.js';
import { authorizePayment, AuthorizePaymentError } from '../modules/payments/authorize-payment.js';

/**
 * Payment authorization APIs (P4.B.5): an analyst approves or holds an audit
 * run's payment. Encapsulated so registerTenantAuthPreHandler binds ONLY to
 * this plugin instance -- registering it at the app level would also gate
 * /health (findings-routes.ts's own precedent/warning).
 *
 * Deliberately excludes do_not_pay (system-generated, P4.B.4) and any read
 * against client_payment_policy (that table is on #161, unmerged, and
 * policy-gated enforcement is P4.B.2's boundary, not this one's).
 */
export async function registerPaymentRoutes(paymentRoutes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(paymentRoutes);

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
