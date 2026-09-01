import { createHash } from 'node:crypto';
import type PgBoss from 'pg-boss';
import type { PoolClient } from '../db/pool.js';
import {
  parseJobPayload,
  type JobName,
  type JobPayloads,
} from './contracts.js';

export interface EnqueueResult {
  jobId: string;
  inserted: boolean;
}

/** Job names whose payload carries the tenant envelope (clientId + idempotencyKey) -- everything except portfolio-wide scan ticks. */
export type TenantScopedJobName = {
  [Name in JobName]: JobPayloads[Name] extends { clientId: string; idempotencyKey: string } ? Name : never;
}[JobName];

export class JobTenantMismatchError extends Error {
  readonly code = 'JOB_TENANT_MISMATCH';

  constructor() {
    super('Job payload tenant does not match transaction tenant');
    this.name = 'JobTenantMismatchError';
  }
}

/** Stable UUID-shaped pg-boss id derived without retaining sensitive key text. */
export function deterministicJobId(name: JobName, clientId: string, key: string): string {
  const bytes = createHash('sha256').update(name).update('\0').update(clientId).update('\0').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // UUID version 8: application-defined bytes
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Enqueue through the caller's PoolClient so domain writes and the job commit
 * or roll back together. Call only from an already tenant-scoped transaction.
 *
 * `jobIdKey`, when passed, replaces `payload.idempotencyKey` as the input to
 * the job id (not the payload's own idempotencyKey field, which some callers
 * -- DELIVER_OUTBOX_MESSAGE_V1 -- forward on to an external sender and so
 * must keep stable across every attempt). Omit it when the payload's
 * idempotencyKey is itself already the right job-id input (RUN_WORKFLOW_
 * COMMAND_V1 folds `attempts` into that field directly since nothing else
 * reads it downstream). A caller whose claim/reclaim cycle can re-enqueue
 * the same logical row more than once (P4.A.7, P4.A.8) MUST vary this key by
 * attempts, or a reclaimed row's re-enqueue collides with its first (now
 * dead/expired) attempt's job id and silently no-ops -- pg-boss's send()
 * with an explicit id no-ops if a job with that id already exists
 * (retentionDays: 30 in policies.ts keeps the old row around) -- leaving the
 * row claimed-then-reclaimed forever with no job ever actually running it
 * again.
 */
export async function enqueueInTransaction<Name extends TenantScopedJobName>(
  boss: Pick<PgBoss, 'send'>,
  client: PoolClient,
  transactionClientId: string,
  name: Name,
  untrustedPayload: unknown,
  jobIdKey?: string,
): Promise<EnqueueResult> {
  const payload = parseJobPayload(name, untrustedPayload);
  if (payload.clientId !== transactionClientId) throw new JobTenantMismatchError();

  const jobId = deterministicJobId(name, payload.clientId, jobIdKey ?? payload.idempotencyKey);
  const db: PgBoss.Db = {
    executeSql: async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };

  const insertedId = await boss.send(name, payload, { id: jobId, db });
  return { jobId, inserted: insertedId !== null };
}
