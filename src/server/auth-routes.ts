import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAuth } from '../auth/better-auth.js';
import { listMembershipClientIds, toFetchHeaders } from '../modules/findings/tenant-auth.js';

/**
 * 86e2wb4zg: the better-auth mount + membership lookup, split out of app.ts's
 * shared import/const seam into its own domain module (86e2wwaeq's
 * architecture review). Mechanical move -- no behavior change; registered by
 * app.ts as `app.register(registerAuthRoutes)`.
 *
 * Registered at TOP LEVEL by the caller, NOT inside findings-routes.ts's
 * tenant-auth-preHandler encapsulation -- both routes here must be reachable
 * with only a session cookie (or no session at all, for /api/auth/*), before
 * any tenant scope exists. Gating them behind tenant-auth would be circular:
 * you'd need a verified tenant context to reach the routes that establish
 * one.
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // 86e2v1bdj: 86e2v1bbr wired getAuth().api.getSession() into tenant-auth.ts
  // for session VERIFICATION only -- nothing mounted better-auth's own
  // handler as an actual HTTP route, so there was no endpoint a login form
  // could POST credentials to (sign-up/sign-in/get-session/sign-out, all of
  // better-auth's built-in routes). better-auth's handler takes/returns the
  // standard Fetch API Request/Response; Fastify's raw req/res need adapting
  // each way.
  app.all('/api/auth/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = `${request.protocol}://${request.hostname}${request.url}`;
    const fetchRequest = new Request(url, {
      method: request.method,
      headers: toFetchHeaders(request),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : JSON.stringify(request.body ?? {}),
    });

    const response = await getAuth().handler(fetchRequest);
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      // set-cookie is the one header Fastify's reply.header() can't append
      // multiple values for via a single call the way Headers.forEach
      // iterates them (better-auth may set more than one cookie) -- raw.
      reply.raw.setHeader(key, key.toLowerCase() === 'set-cookie' ? response.headers.getSetCookie() : value);
    });
    const body = await response.text();
    return reply.send(body || null);
  });

  // 86e2wb92b: a real (non-dev-header) session proves WHO the user is, but
  // resolveViaSession (tenant-auth.ts) still requires an explicit
  // x-client-id header -- nothing previously told the frontend WHICH
  // client_id to send. This is that lookup: verify the session, then return
  // the client_id(s) the user has a membership row for, so login can store
  // one and start sending it as x-client-id on subsequent requests.
  app.get('/api/auth/memberships', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await getAuth().api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const clientIds = await listMembershipClientIds(session.user.id);
    return { clientIds };
  });
}
