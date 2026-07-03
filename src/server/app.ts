import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Build the Fastify application instance.
 *
 * Kept separate from the server bootstrap (`index.ts`) so tests can build the
 * app and call `.inject()` without binding a TCP port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  return app;
}
