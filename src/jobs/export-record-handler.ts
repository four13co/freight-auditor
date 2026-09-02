import type pg from 'pg';
import { parseJobPayload, JOB_NAMES, type JobPayloads } from './contracts.js';
import { ExportAdapterRegistry } from '../modules/exports/export-adapter.js';
import { recordExportAcknowledgement } from '../modules/exports/record-export-acknowledgement.js';

type ExportRecordPayload = JobPayloads[typeof JOB_NAMES.EXPORT_RECORD_V1];

export class ExportRecordFailedError extends Error {
  constructor(readonly reason: string) {
    super(`export attempt failed: ${reason}`);
    this.name = 'ExportRecordFailedError';
  }
}

export interface ExportRecordJobDeps {
  registry: ExportAdapterRegistry;
  recordAcknowledgement: typeof recordExportAcknowledgement;
}

/**
 * No concrete AP/ERP adapter is registered yet (P4.B.8 deferred vendor
 * choice), so the default registry starts empty -- every real systemCode
 * resolves NOT_CONFIGURED until a future task registers a real adapter,
 * same "shipped without a live trigger" rollout P4.A.5's outbox dispatcher
 * used.
 */
const defaultDeps: ExportRecordJobDeps = {
  registry: new ExportAdapterRegistry([]),
  recordAcknowledgement: recordExportAcknowledgement,
};

/**
 * Runs one EXPORT_RECORD_V1 job: calls ExportAdapterRegistry.export(), then
 * persists the outcome via recordExportAcknowledgement for a settled result.
 *
 * Deliberately NOT built on job-dispatcher.ts's createJobDispatcher, unlike
 * its sibling handlers (deliver-outbox-message-handler.ts,
 * run-workflow-command-handler.ts): that factory's contract is
 * handler-succeeds -> complete() -> audit event, handler-throws -> no
 * complete, retry -- a strict success/failure split. This job's contract is
 * three-way (ACKNOWLEDGED: persist, complete; FAILED: persist too, but still
 * retry; NOT_CONFIGURED: neither persist nor retry), which the generic
 * factory has no seam for. recordExportAcknowledgement already writes its
 * own audit event on a newly-created row, so this handler adds no separate
 * one.
 *
 * At-least-once semantics: a crash after the adapter call but before
 * recordExportAcknowledgement runs means a retry re-calls the adapter --
 * safe because both the adapter's own dedupeKey de-duplication
 * (ExportAdapterRegistry/ExportAdapter contract) and
 * recordExportAcknowledgement's (clientId, systemCode, dedupeKey) idempotent
 * insert make a repeat ACKNOWLEDGED delivery a no-op rather than a second
 * external effect or a duplicate reconciliation row. A FAILED result is
 * different: export_acknowledgement is append-only for FAILED rows (each
 * attempt is a distinct, legitimate outcome), so every retry that fails
 * again persists its own row -- matching recordPartialRecovery's precedent
 * for recovery_event.
 */
export async function handleExportRecordJob(
  client: pg.PoolClient,
  untrustedPayload: unknown,
  deps: ExportRecordJobDeps = defaultDeps,
): Promise<void> {
  const payload = parseJobPayload(JOB_NAMES.EXPORT_RECORD_V1, untrustedPayload) as ExportRecordPayload;

  const result = await deps.registry.export(client, {
    systemCode: payload.systemCode,
    dedupeKey: payload.idempotencyKey,
    payload: payload.payload,
  });

  if (result.status === 'NOT_CONFIGURED') {
    return;
  }

  await deps.recordAcknowledgement(client, {
    clientId: payload.clientId,
    claimId: payload.claimId,
    paymentGateDecisionId: payload.paymentGateDecisionId,
    record: { systemCode: payload.systemCode, dedupeKey: payload.idempotencyKey },
    result,
  });

  if (result.status === 'FAILED') {
    throw new ExportRecordFailedError(result.reason);
  }
}
