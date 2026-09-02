import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../modules/audit-ledger/write-audit-event.js';

/**
 * Shared registry + dispatch -> complete -> writeAuditEvent sequence
 * extracted from run-workflow-command-handler.ts and
 * deliver-outbox-message-handler.ts, which independently reimplemented the
 * same Map<string, Handler> registry and the same ~30 lines of dispatch
 * logic around it. Each caller configures the handful of things that
 * actually differ -- the type-discriminator field, how to read its own
 * (differently-named) deps' registry, the handler ctx shape, the completion
 * call, and the audit event's entity/event/detail -- and gets back the one
 * registry Map this file owns plus a ready-to-use dispatch function.
 */
export interface JobDispatcherConfig<TPayload extends { clientId: string }, TCtx, TDeps> {
  getTypeKey: (payload: TPayload) => string;
  getRegistry: (deps: TDeps) => Map<string, (client: pg.PoolClient, ctx: TCtx) => Promise<void>>;
  buildCtx: (payload: TPayload) => TCtx;
  complete: (deps: TDeps, client: pg.PoolClient, payload: TPayload) => Promise<unknown>;
  buildAuditEvent: (payload: TPayload) => {
    entity: string;
    entityId: string;
    event: string;
    detail: Record<string, unknown>;
  };
  createError: (typeKey: string) => Error;
}

export type JobHandler<TCtx> = (client: pg.PoolClient, ctx: TCtx) => Promise<void>;

export interface JobDispatcher<TPayload, TCtx, TDeps> {
  /** The one Map<string, Handler> registry backing this dispatcher. */
  registry: Map<string, JobHandler<TCtx>>;
  /** Registers a handler for a type key -- what each module's registerX export delegates to. */
  register: (typeKey: string, handler: JobHandler<TCtx>) => void;
  dispatch: (client: pg.PoolClient, payload: TPayload, deps: TDeps) => Promise<void>;
}

export function createJobDispatcher<TPayload extends { clientId: string }, TCtx, TDeps>(
  config: JobDispatcherConfig<TPayload, TCtx, TDeps>,
): JobDispatcher<TPayload, TCtx, TDeps> {
  const registry = new Map<string, JobHandler<TCtx>>();

  const register: JobDispatcher<TPayload, TCtx, TDeps>['register'] = (typeKey, handler) => {
    registry.set(typeKey, handler);
  };

  const dispatch: JobDispatcher<TPayload, TCtx, TDeps>['dispatch'] = async (client, payload, deps) => {
    const typeKey = config.getTypeKey(payload);
    const handler = config.getRegistry(deps).get(typeKey);
    if (!handler) throw config.createError(typeKey);

    await handler(client, config.buildCtx(payload));
    await config.complete(deps, client, payload);

    const auditEvent = config.buildAuditEvent(payload);
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(payload.clientId, auditEvent.entityId, auditEvent.event),
      clientId: payload.clientId,
      entity: auditEvent.entity,
      entityId: auditEvent.entityId,
      event: auditEvent.event,
      actorKind: 'system',
      detail: auditEvent.detail,
    });
  };

  return { registry, register, dispatch };
}
