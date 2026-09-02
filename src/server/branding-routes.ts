import type { FastifyInstance } from 'fastify';
import { withTenantReadTx } from '../db/tenant-context.js';
import { resolveBrandingByDomain } from '../modules/identity/resolve-branding-by-domain.js';

/**
 * 86e320pkc: per-Customer white-labeling. GET /api/branding tells the
 * frontend (any user -- the Customer's own users, a Grand Customer, or a
 * Grand Vendor, none of whom have signed in yet when this fires) which
 * logo/colors to render, resolved purely from the request's own Host header
 * -- the same domain the browser is already showing in its address bar,
 * requiring no query param or client-supplied hint.
 *
 * Registered at TOP LEVEL (app.ts), same posture as /health and /metrics:
 * unauthenticated, reachable before any tenant scope exists, since branding
 * must be visible on the login page itself, not only after sign-in.
 * Exposes only public branding assets (logo URL, colors) -- never client_id
 * or any other tenant data -- so no auth gate is needed to leak anything.
 *
 * Uses withTenantReadTx, internal scope -- the same shape tenant-auth.ts's
 * lookupMembership uses: domain resolution is how the caller's tenant gets
 * DISCOVERED, so it cannot run inside a tenant scope that doesn't exist yet.
 */
export async function registerBrandingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/branding', async (request, reply) => {
    const host = request.headers.host;
    if (!host) {
      return reply.send({ branded: false });
    }

    const branding = await withTenantReadTx({ internal: true }, (client) =>
      resolveBrandingByDomain(client, host),
    );

    if (!branding) {
      // AC2: no configuration for this domain (including the platform's own
      // default domain) -- the frontend falls back to default platform
      // branding, unaffected by any other Customer's configuration.
      return reply.send({ branded: false });
    }

    return reply.send({
      branded: true,
      logoUrl: branding.logoUrl,
      primaryColor: branding.primaryColor,
      secondaryColor: branding.secondaryColor,
    });
  });
}
