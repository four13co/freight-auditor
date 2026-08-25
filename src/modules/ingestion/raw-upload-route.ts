import type { FastifyInstance } from 'fastify';
import type { TenantContext } from '../../db/tenant-context.js';

export function objectStoreRoot(): string {
  return process.env.OBJECT_STORE_ROOT ?? './.data/object-store';
}

export function registerBufferContentTypeParser(routes: FastifyInstance, contentTypes: string[]): void {
  routes.addContentTypeParser(contentTypes, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
}

export function requireNonEmptyBuffer(body: unknown): Buffer | null {
  return Buffer.isBuffer(body) && body.byteLength > 0 ? body : null;
}

export function requireSingleClientId(ctx: TenantContext): string | null {
  return ctx.clientIds?.length === 1 ? ctx.clientIds[0]! : null;
}
