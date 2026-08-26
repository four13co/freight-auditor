import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';
import { evaluateInvoice } from '../evaluator/evaluate-invoice.js';
import type { ContractFacts } from '../evaluator/fact-bundle.js';
import { CONTRACT_RUBRIC } from '../rubric-resolver/contract-rubric.js';
import { ENGINE_SPEC_VERSION, STANDARD_RUBRIC } from '../rubric-resolver/standard-rubric.js';
import {
  AuditReplayManifestSchema,
  canonicalJson,
  replayManifestHash,
  type AuditReplayManifest,
} from './replay-manifest.js';
import { deterministicAuditEventId, writeAuditEvent } from './write-audit-event.js';

export class ReplayNotFoundError extends Error {}
export class ReplayIntegrityError extends Error { readonly code = 'REPLAY_INTEGRITY_FAILED'; }
export class ReplayUnavailableError extends Error { readonly code = 'REPLAY_VERSION_UNAVAILABLE'; }

async function verifyPins(client: pg.PoolClient, manifest: AuditReplayManifest): Promise<void> {
  for (const source of manifest.sourceDocuments) {
    const row = (await client.query<{ sha256: string }>(`SELECT sha256 FROM source_document WHERE id = $1`, [source.id])).rows[0];
    if (!row || row.sha256 !== source.sha256) throw new ReplayIntegrityError('source document pin mismatch');
  }
  for (const rule of manifest.ruleVersions) {
    const row = (await client.query<{ ast_hash: string }>(`SELECT ast_hash FROM rule_version WHERE id = $1`, [rule.id])).rows[0];
    if (!row || (rule.contentHash && row.ast_hash !== rule.contentHash)) throw new ReplayIntegrityError('rule version pin mismatch');
  }
  for (const contract of manifest.contractVersions) {
    if (!contract.contentHash) continue;
    const row = (await client.query<{ sha256: string | null }>(
      `SELECT sd.sha256 FROM contract_version cv LEFT JOIN source_document sd ON sd.id = cv.source_document_id WHERE cv.id = $1`,
      [contract.id],
    )).rows[0];
    if (!row || row.sha256 !== contract.contentHash) throw new ReplayIntegrityError('contract version pin mismatch');
  }
}

export async function replayAuditRun(client: pg.PoolClient, auditRunId: string): Promise<{
  auditRunId: string; manifestHash: string; originalResultHash: string; resultHash: string;
  byteIdentical: true; matchesOriginal: true; result: unknown;
}> {
  const row = (await client.query<{ content_hash: string; manifest: unknown }>(
    `SELECT content_hash, manifest FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId],
  )).rows[0];
  if (!row) throw new ReplayNotFoundError('audit replay manifest not found');

  const parsed = AuditReplayManifestSchema.safeParse(row.manifest);
  if (!parsed.success) throw new ReplayIntegrityError('stored replay manifest is invalid');
  const manifest = parsed.data;
  if (manifest.auditRunId !== auditRunId || replayManifestHash(manifest) !== row.content_hash) {
    throw new ReplayIntegrityError('replay manifest hash mismatch');
  }
  await verifyPins(client, manifest);
  if (manifest.engineSpecVersion !== ENGINE_SPEC_VERSION) {
    throw new ReplayUnavailableError('pinned engine version is not installed');
  }
  if (manifest.rubric.snapshotId !== null) {
    throw new ReplayUnavailableError('custom rubric snapshot replay is not installed');
  }

  const rubric = manifest.contractVersions.length > 0 ? CONTRACT_RUBRIC : STANDARD_RUBRIC;
  const contract = manifest.contractVersions.length > 0
    ? manifest.resolvedInputs as unknown as ContractFacts
    : undefined;
  const result = evaluateInvoice(manifest.invoice as unknown as ParsedInvoice, rubric, contract);
  const resultBytes = Buffer.from(canonicalJson(result));
  const originalBytes = Buffer.from(canonicalJson(manifest.result));
  const resultHash = createHash('sha256').update(resultBytes).digest('hex');
  const originalResultHash = createHash('sha256').update(originalBytes).digest('hex');
  if (!resultBytes.equals(originalBytes)) {
    throw new ReplayIntegrityError('replay result is not byte-identical to the pinned result');
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(manifest.clientId, auditRunId, resultHash, 'replay.executed'),
    clientId: manifest.clientId,
    entity: 'audit_run',
    entityId: auditRunId,
    event: 'replay.executed',
    actorKind: 'system',
    detail: { manifestHash: row.content_hash, originalResultHash, resultHash, byteIdentical: true },
  });
  return {
    auditRunId, manifestHash: row.content_hash, originalResultHash, resultHash,
    byteIdentical: true, matchesOriginal: true, result,
  };
}
