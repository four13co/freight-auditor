import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { createJobDispatcher } from '../../src/jobs/job-dispatcher.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const ENTITY_ID = '20000000-0000-4000-8000-000000000001';

function fakeClient(): pg.PoolClient {
  return { query: vi.fn().mockResolvedValue({ rows: [{ id: 'audit-event-id', created: true }], rowCount: 1 }) } as unknown as pg.PoolClient;
}

interface TestPayload {
  clientId: string;
  type: string;
  entityId: string;
}

interface TestDeps {
  registry: Map<string, (client: pg.PoolClient, ctx: TestPayload) => Promise<void>>;
  complete: (client: pg.PoolClient, args: { clientId: string; entityId: string }) => Promise<{ found: boolean }>;
}

class TestUnregisteredError extends Error {
  constructor(readonly typeKey: string) {
    super(`unregistered: ${typeKey}`);
  }
}

function buildDispatch() {
  const { dispatch } = createJobDispatcher<TestPayload, TestPayload, TestDeps>({
    getTypeKey: (payload) => payload.type,
    getRegistry: (deps) => deps.registry,
    buildCtx: (payload) => payload,
    complete: (deps, client, payload) => deps.complete(client, { clientId: payload.clientId, entityId: payload.entityId }),
    buildAuditEvent: (payload) => ({
      entity: 'test_entity',
      entityId: payload.entityId,
      event: 'test.event',
      detail: { type: payload.type },
    }),
    createError: (typeKey) => new TestUnregisteredError(typeKey),
  });
  return dispatch;
}

describe('createJobDispatcher (generic engine)', () => {
  it('dispatches to the registered handler, completes, then writes an audit event, in that order', async () => {
    const dispatch = buildDispatch();
    const client = fakeClient();
    const calls: string[] = [];
    const handler = vi.fn().mockImplementation(async () => { calls.push('handler'); });
    const complete = vi.fn().mockImplementation(async () => { calls.push('complete'); return { found: true }; });
    const registry = new Map([['known', handler]]);

    await dispatch(client, { clientId: CLIENT_ID, type: 'known', entityId: ENTITY_ID }, { registry, complete });

    expect(calls).toEqual(['handler', 'complete']);
    expect(handler).toHaveBeenCalledWith(client, { clientId: CLIENT_ID, type: 'known', entityId: ENTITY_ID });
    expect(complete).toHaveBeenCalledWith(client, { clientId: CLIENT_ID, entityId: ENTITY_ID });
    const auditInsert = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('audit_event'),
    );
    expect(auditInsert).toBeDefined();
  });

  it('fails closed for an unregistered type key: no handler call, no completion, no audit event', async () => {
    const dispatch = buildDispatch();
    const client = fakeClient();
    const complete = vi.fn();
    const registry = new Map<string, (client: pg.PoolClient, ctx: TestPayload) => Promise<void>>();

    await expect(dispatch(client, { clientId: CLIENT_ID, type: 'missing', entityId: ENTITY_ID }, { registry, complete }))
      .rejects.toBeInstanceOf(TestUnregisteredError);

    expect(complete).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('propagates a handler failure without completing (claimed, not done, so the caller retries)', async () => {
    const dispatch = buildDispatch();
    const client = fakeClient();
    const failure = new Error('downstream effect failed');
    const handler = vi.fn().mockRejectedValue(failure);
    const complete = vi.fn();
    const registry = new Map([['known', handler]]);

    await expect(dispatch(client, { clientId: CLIENT_ID, type: 'known', entityId: ENTITY_ID }, { registry, complete }))
      .rejects.toThrow(failure);

    expect(complete).not.toHaveBeenCalled();
  });
});

describe('run-workflow-command-handler.ts and deliver-outbox-message-handler.ts share one dispatcher implementation', () => {
  // Source-text checks, not behavioral ones: two independently-written
  // implementations can produce identical behavior for every test above
  // while still being two copies of the dispatch/complete/audit sequence.
  // The AC is specifically that only one such sequence exists in the
  // codebase (grep confirms no second Map<string, Handler>-based dispatch
  // implementation) -- that claim is only provable by reading the source.
  const jobsDir = join(import.meta.dirname, '../../src/jobs');

  it('both handler modules import createJobDispatcher from job-dispatcher.js', () => {
    const runWorkflowSource = readFileSync(join(jobsDir, 'run-workflow-command-handler.ts'), 'utf8');
    const deliverOutboxSource = readFileSync(join(jobsDir, 'deliver-outbox-message-handler.ts'), 'utf8');

    expect(runWorkflowSource).toMatch(/import\s*\{\s*createJobDispatcher\s*\}\s*from\s*['"]\.\/job-dispatcher\.js['"]/);
    expect(deliverOutboxSource).toMatch(/import\s*\{\s*createJobDispatcher\s*\}\s*from\s*['"]\.\/job-dispatcher\.js['"]/);
  });

  it('run-workflow-command-handler.ts and deliver-outbox-message-handler.ts declare no Handler/Sender registry of their own (AC1)', () => {
    // AC1's literal wording: "grep confirms no second Map<string, Handler>-based
    // registry remains." Scoped to the two files the ticket names (and their
    // registry types specifically) rather than every file under src/jobs/ --
    // a future job file is free to keep its own unrelated Map (e.g. a
    // grouping/lookup map, the same shape used ~16x under src/modules/), and
    // that must not fail a test labeled AC1.
    const offenders = ['run-workflow-command-handler.ts', 'deliver-outbox-message-handler.ts']
      .filter((file) => /=\s*new Map<string,\s*\w*(Handler|Sender)\b/.test(readFileSync(join(jobsDir, file), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('run-workflow-command-handler.ts and deliver-outbox-message-handler.ts no longer call writeAuditEvent directly', () => {
    // Scoped to the two files being unified, not every file under src/jobs/ --
    // a future job handler (e.g. a scan-tick) may legitimately need to write
    // its own audit event outside this dispatch/complete/audit shape.
    const offenders = ['run-workflow-command-handler.ts', 'deliver-outbox-message-handler.ts']
      .filter((file) => /writeAuditEvent\(/.test(readFileSync(join(jobsDir, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
