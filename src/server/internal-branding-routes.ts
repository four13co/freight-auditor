import type { FastifyInstance } from 'fastify';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler, registerAnalystOnlyPreHandler } from '../modules/findings/tenant-auth.js';
import { requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { updateCustomerBranding } from '../modules/identity/update-customer-branding.js';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 86e37r2t4: PATCH /api/internal/branding -- the write half of per-Customer
 * white-labeling (86e320pkc's GET /api/branding, branding-routes.ts, is
 * read-only and unauthenticated; that route's contract is deliberately left
 * untouched by this item, hence a separate file rather than editing it).
 *
 * Gated with registerTenantAuthPreHandler + registerAnalystOnlyPreHandler --
 * NOT registerInternalAnalystAuthPreHandler (internal-analyst-auth.ts),
 * which this item's own task body originally named. That resolver
 * deliberately grants `{ internal: true }` with NO clientIds at all (reserved
 * for genuinely cross-client routes like portfolio-routes.ts), which would
 * let an internal analyst overwrite ANY tenant's branding regardless of
 * which one they belong to -- the exact cross-tenant defect 86e37r2rt's
 * first attempt (PR #372, closed on review) shipped for the sibling Invoices
 * item. registerTenantAuthPreHandler + registerAnalystOnlyPreHandler (the
 * same pair dispute-review-routes.ts/findings-routes.ts/payment-routes.ts
 * already use) scopes this PATCH to the caller's own tenant via a real
 * TenantContext, with a portal (client_viewer/client_admin) session rejected
 * at 403.
 *
 * Nested in its own registered sub-scope (rather than applying
 * registerAnalystOnlyPreHandler directly on `routes`) so
 * scripts/check-analyst-only-gating.mjs's static scan -- which only
 * recognizes a role gate via a `<scope>.register(async (<var>) => {...})`
 * block calling a role-scoped preHandler on `<var>` -- can see this route is
 * gated, matching every other analyst-only mutation in this codebase
 * (dispute-review-routes.ts, payment-routes.ts).
 */
export async function registerInternalBrandingRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  await routes.register(async (analystOnlyRoutes) => {
    await registerAnalystOnlyPreHandler(analystOnlyRoutes);

    analystOnlyRoutes.patch('/api/internal/branding', async (request, reply) => {
      const body = request.body as { logoUrl?: unknown; primaryColor?: unknown; secondaryColor?: unknown };

      if (typeof body.logoUrl !== 'string' || !isValidHttpUrl(body.logoUrl)) {
        await reply.code(400).send({ error: 'invalid logoUrl: must be a valid http(s) URL' });
        return;
      }
      if (typeof body.primaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.primaryColor)) {
        await reply.code(400).send({ error: 'invalid primaryColor: must be a hex color like #112233' });
        return;
      }
      if (
        body.secondaryColor !== undefined &&
        body.secondaryColor !== null &&
        (typeof body.secondaryColor !== 'string' || !HEX_COLOR_PATTERN.test(body.secondaryColor))
      ) {
        await reply.code(400).send({ error: 'invalid secondaryColor: must be a hex color like #112233, or null' });
        return;
      }

      const clientId = requireSingleClientId(request.tenantContext!);
      if (!clientId) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const result = await withTenantTx(request.tenantContext!, (client) =>
        updateCustomerBranding(client, clientId, {
          logoUrl: body.logoUrl as string,
          primaryColor: body.primaryColor as string,
          secondaryColor: (body.secondaryColor as string | null | undefined) ?? null,
        }),
      );

      if (!result.found) {
        await reply.code(404).send({ error: 'no branding configuration exists for this tenant yet' });
        return;
      }
      return result.branding;
    });
  });
}
