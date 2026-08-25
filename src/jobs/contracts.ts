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
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const JOB_DEAD_LETTER_NAMES: Record<JobName, string> = {
  [JOB_NAMES.PROCESS_INGESTION_V1]: 'freight.ingestion.process.dead-letter.v1',
  [JOB_NAMES.EVALUATE_AUDIT_V1]: 'freight.audit.evaluate.dead-letter.v1',
  [JOB_NAMES.REPLAY_AUDIT_V1]: 'freight.audit.replay.dead-letter.v1',
  [JOB_NAMES.SYNC_REFERENCE_DATA_V1]: 'freight.reference-data.sync.dead-letter.v1',
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
