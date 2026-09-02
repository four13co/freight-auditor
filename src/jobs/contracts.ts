import { z } from 'zod';

/**
 * Queue names are public, versioned contracts. Never change a payload schema
 * in place; register a new name and schema when compatibility must break.
 */
export const JOB_NAMES = {
  PROCESS_INGESTION_V1: 'freight.ingestion.process.v1',
  EVALUATE_AUDIT_V1: 'freight.audit.evaluate.v1',
  REPLAY_AUDIT_V1: 'freight.audit.replay.v1',
  SYNC_REFERENCE_DATA_V1: 'freight.reference-data.sync.v1',
  POLL_SFTP_V1: 'freight.ingestion.sftp.poll.v1',
  ESCALATE_CLAIM_V1: 'freight.claims.escalate.v1',
  FOLLOW_UP_CLAIM_V1: 'freight.claims.follow-up.v1',
  SCAN_CLAIM_AGING_V1: 'freight.claims.scan-aging.v1',
  DISCOVER_TRIGGERS_V1: 'freight.discovery.detect-triggers.v1',
  SCAN_WORKFLOW_COMMANDS_V1: 'freight.workflow.scan-commands.v1',
  RUN_WORKFLOW_COMMAND_V1: 'freight.workflow.run-command.v1',
  SCAN_OUTBOX_MESSAGES_V1: 'freight.workflow.scan-outbox.v1',
  DELIVER_OUTBOX_MESSAGE_V1: 'freight.workflow.deliver-outbox-message.v1',
  EXPORT_RECORD_V1: 'freight.exports.export-record.v1',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const JOB_DEAD_LETTER_NAMES: Record<JobName, string> = {
  [JOB_NAMES.PROCESS_INGESTION_V1]: 'freight.ingestion.process.dead-letter.v1',
  [JOB_NAMES.EVALUATE_AUDIT_V1]: 'freight.audit.evaluate.dead-letter.v1',
  [JOB_NAMES.REPLAY_AUDIT_V1]: 'freight.audit.replay.dead-letter.v1',
  [JOB_NAMES.SYNC_REFERENCE_DATA_V1]: 'freight.reference-data.sync.dead-letter.v1',
  [JOB_NAMES.POLL_SFTP_V1]: 'freight.ingestion.sftp.poll.dead-letter.v1',
  [JOB_NAMES.ESCALATE_CLAIM_V1]: 'freight.claims.escalate.dead-letter.v1',
  [JOB_NAMES.FOLLOW_UP_CLAIM_V1]: 'freight.claims.follow-up.dead-letter.v1',
  [JOB_NAMES.SCAN_CLAIM_AGING_V1]: 'freight.claims.scan-aging.dead-letter.v1',
  [JOB_NAMES.DISCOVER_TRIGGERS_V1]: 'freight.discovery.detect-triggers.dead-letter.v1',
  [JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1]: 'freight.workflow.scan-commands.dead-letter.v1',
  [JOB_NAMES.RUN_WORKFLOW_COMMAND_V1]: 'freight.workflow.run-command.dead-letter.v1',
  [JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1]: 'freight.workflow.scan-outbox.dead-letter.v1',
  [JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1]: 'freight.workflow.deliver-outbox-message.dead-letter.v1',
  [JOB_NAMES.EXPORT_RECORD_V1]: 'freight.exports.export-record.dead-letter.v1',
};

const id = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(255);

const envelope = {
  schemaVersion: z.literal(1),
  clientId: id,
  idempotencyKey,
  requestedAt: z.iso.datetime({ offset: true }),
};

export const jobPayloadSchemas = {
  [JOB_NAMES.PROCESS_INGESTION_V1]: z.object({
    ...envelope,
    sourceObjectId: id,
  }).strict(),
  [JOB_NAMES.EVALUATE_AUDIT_V1]: z.object({
    ...envelope,
    auditRunId: id,
  }).strict(),
  [JOB_NAMES.REPLAY_AUDIT_V1]: z.object({
    ...envelope,
    auditRunId: id,
    replayRequestId: id,
  }).strict(),
  [JOB_NAMES.SYNC_REFERENCE_DATA_V1]: z.object({
    ...envelope,
    source: z.enum(['eia_diesel', 'mileage', 'ocean_tariff', 'nmfc']),
    publicationVersion: z.string().trim().min(1).max(255),
  }).strict(),
  [JOB_NAMES.POLL_SFTP_V1]: z.object({
    ...envelope,
    connectionId: id,
  }).strict(),
  [JOB_NAMES.ESCALATE_CLAIM_V1]: z.object({
    ...envelope,
    claimId: id,
  }).strict(),
  [JOB_NAMES.FOLLOW_UP_CLAIM_V1]: z.object({
    ...envelope,
    claimId: id,
  }).strict(),
  // No clientId: this tick is a portfolio-wide scan across every active
  // client, not a per-tenant request, so the usual envelope doesn't fit.
  [JOB_NAMES.SCAN_CLAIM_AGING_V1]: z.object({
    schemaVersion: z.literal(1),
    requestedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  // Audit-run-scoped only for now (wraps P3.D.1/D.2/D.4). P3.D.3's
  // extraction-quality detector is source-document-scoped -- extraction runs
  // independent of any audit run -- and lives on an unmerged PR (#225) as of
  // this task; wiring a second, differently-scoped variant in now would
  // couple this independently-buildable job to that PR landing first (the
  // same coupling PR #158 explicitly avoided for the same reason). Follow-up
  // once #225 merges: widen this to a discriminated union (scope: AUDIT_RUN |
  // EXTRACTION), matching detect-extraction-quality-triggers.ts's shape.
  [JOB_NAMES.DISCOVER_TRIGGERS_V1]: z.object({
    ...envelope,
    auditRunId: id,
  }).strict(),
  // Portfolio-wide scan tick (P4.A.4), same no-tenant shape as
  // SCAN_CLAIM_AGING_V1: it iterates every active client itself rather than
  // being dispatched per-tenant.
  [JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1]: z.object({
    schemaVersion: z.literal(1),
    requestedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  // Dispatches one already-claimed workflow_command (P4.A.3) row for
  // execution. commandType is deliberately open text -- no hardcoded
  // command graph, mirroring workflow_instance.workflow_type/current_state
  // (0046) -- so this carries whatever payload the scheduler stored; the
  // handler registry (run-workflow-command-handler.ts) is what interprets it
  // per commandType, not this schema.
  [JOB_NAMES.RUN_WORKFLOW_COMMAND_V1]: z.object({
    ...envelope,
    commandId: id,
    workflowInstanceId: id,
    commandType: z.string().regex(/^[a-z][a-z0-9_]*$/),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  // Portfolio-wide scan tick (P4.A.6), same no-tenant shape as
  // SCAN_WORKFLOW_COMMANDS_V1: iterates every active client itself.
  [JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1]: z.object({
    schemaVersion: z.literal(1),
    requestedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  // Dispatches one already-claimed workflow_outbox_message (P4.A.5) row to
  // the sender registered for its messageType (deliver-outbox-message-
  // handler.ts). `idempotencyKey` here IS the message's own dedupe_key --
  // the same value on every attempt, so a sender that wraps a real external
  // call (an HTTP request to a carrier, a payment provider, etc.) can pass
  // it straight through as that provider's own idempotency-key mechanism.
  // messageType is deliberately open text, mirroring commandType above --
  // no hardcoded sender graph; the sender registry interprets it, not this
  // schema.
  [JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1]: z.object({
    ...envelope,
    outboxMessageId: id,
    workflowInstanceId: id,
    commandId: id,
    messageType: z.string().regex(/^[a-z][a-z0-9_]*$/),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  // Dispatches one AP/ERP export attempt through ExportAdapterRegistry
  // (P4.B.8, export-adapter.ts) and persists the outcome via
  // recordExportAcknowledgement (P4.B.9). `idempotencyKey` here IS the
  // export's own dedupeKey, same convention as DELIVER_OUTBOX_MESSAGE_V1's
  // messageType envelope field -- stable across retries, passed straight
  // through to the adapter and to recordExportAcknowledgement's own
  // idempotency check. Exactly one of claimId/paymentGateDecisionId must be
  // set for a settled (ACKNOWLEDGED/FAILED) result to persist -- enforced by
  // recordExportAcknowledgement itself (MISSING_ORIGIN), not this schema,
  // since a NOT_CONFIGURED result never reaches that call.
  [JOB_NAMES.EXPORT_RECORD_V1]: z.object({
    ...envelope,
    claimId: id.nullable().default(null),
    paymentGateDecisionId: id.nullable().default(null),
    systemCode: z.string().trim().min(1).max(255),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
} satisfies Record<JobName, z.ZodType>;

export type JobPayloads = {
  [Name in JobName]: z.infer<(typeof jobPayloadSchemas)[Name]>;
};

export class JobPayloadValidationError extends Error {
  readonly code = 'JOB_PAYLOAD_INVALID';

  constructor(
    readonly jobName: JobName,
    readonly issues: ReadonlyArray<{ path: string; code: string }>,
  ) {
    super(`Invalid payload for ${jobName}`);
    this.name = 'JobPayloadValidationError';
  }
}

/** Validate untrusted queue data without leaking payload values into errors. */
export function parseJobPayload<Name extends JobName>(
  jobName: Name,
  payload: unknown,
): JobPayloads[Name] {
  const result = jobPayloadSchemas[jobName].safeParse(payload);
  if (!result.success) {
    throw new JobPayloadValidationError(
      jobName,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    );
  }
  return result.data as JobPayloads[Name];
}
