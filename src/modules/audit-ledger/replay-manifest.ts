import { createHash } from 'node:crypto';
import { z } from 'zod';

// PostgreSQL's uuid type accepts all canonical 8-4-4-4-12 hexadecimal values;
// do not impose RFC version/variant bits on database-generated or fixture IDs.
const postgresUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const pin = z.object({ id: postgresUuid, contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export const AuditReplayManifestSchema = z.object({
  schemaVersion: z.literal(1),
  auditRunId: postgresUuid,
  clientId: postgresUuid,
  engineSpecVersion: z.string().min(1),
  parser: z.object({ transactionSet: z.string().min(1), version: z.string().min(1) }).strict(),
  sourceDocuments: z.array(z.object({ id: postgresUuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  rubric: z.object({
    snapshotId: postgresUuid.nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    resolverVersion: z.string().nullable(),
  }).strict(),
  ruleVersions: z.array(pin),
  contractVersions: z.array(pin),
  externalValues: z.array(pin),
  crosswalkRows: z.array(pin),
  ai: z.array(z.object({ model: z.string().min(1), promptVersion: z.string().min(1) }).strict()),
  resolvedInputs: z.json(),
  invoice: z.json(),
  result: z.json(),
}).strict();

export type AuditReplayManifest = z.infer<typeof AuditReplayManifestSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function canonicalManifestJson(untrusted: unknown): string {
  return canonicalJson(AuditReplayManifestSchema.parse(untrusted));
}

export function replayManifestHash(manifest: AuditReplayManifest): string {
  return createHash('sha256').update(canonicalManifestJson(manifest)).digest('hex');
}
