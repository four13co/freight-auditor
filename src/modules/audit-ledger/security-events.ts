import type { FastifyRequest } from 'fastify';
import { withTenantTx } from '../../db/tenant-context.js';
import { deterministicAuditEventId, writeAuditEvent } from './write-audit-event.js';
import { isUuid } from '../../shared/request-validation.js';

export async function writeSecurityEvent(args: {
  request: Pick<FastifyRequest, 'id'>;
  event: string;
  clientId?: string;
  actorUserId?: string;
  detail?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await withTenantTx({ internal: true }, (client) => writeAuditEvent(client, {
    id: deterministicAuditEventId(String(args.request.id), args.event),
    clientId: args.clientId && isUuid(args.clientId) ? args.clientId : null,
    entity: args.event.startsWith('authorization.') ? 'authorization' : 'authentication',
    entityId: null,
    event: args.event,
    actorKind: args.actorUserId ? 'analyst' : 'system',
    actorUserId: args.actorUserId && isUuid(args.actorUserId) ? args.actorUserId : null,
    detail: args.detail ?? null,
  })).then(() => undefined);
}

export function authenticationAction(method: string, url: string): string | null {
  if (method !== 'POST') return null;
  const path = url.split('?')[0] ?? '';
  const action = new Map([
    ['/api/auth/sign-up/email', 'sign_up_email'],
    ['/api/auth/sign-in/email', 'sign_in_email'],
    ['/api/auth/sign-out', 'sign_out'],
    ['/api/auth/passkey/add-passkey', 'passkey_add'],
    ['/api/auth/passkey/delete-passkey', 'passkey_delete'],
    ['/api/auth/passkey/sign-in', 'passkey_sign_in'],
  ]).get(path);
  return action ?? null;
}
