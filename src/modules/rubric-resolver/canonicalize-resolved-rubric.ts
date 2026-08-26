import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { canonicalJson } from '../audit-ledger/replay-manifest.js';

export const RESOLVED_RUBRIC_DOCUMENT_VERSION = 1;
const DocumentSchema = z.object({
  schemaVersion: z.literal(RESOLVED_RUBRIC_DOCUMENT_VERSION),
  resolverVersion: z.string().trim().min(1),
  criteria: z.array(z.record(z.string(), z.json())),
}).catchall(z.json());

const setLikeKeys = new Set(['criteria', 'members', 'ruleVersions', 'humanOverrides', 'conflicts']);

function normalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    return parentKey && setLikeKeys.has(parentKey)
      ? items.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
      : items;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.decimal === 'string') {
      try { return { decimal: new Decimal(record.decimal).toFixed() }; } catch { throw new ResolvedRubricDocumentError(); }
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = normalize(record[key], key);
    return out;
  }
  return value;
}

export class ResolvedRubricDocumentError extends Error {
  readonly code = 'RESOLVED_RUBRIC_DOCUMENT_INVALID';
  constructor() {
    super('Invalid resolved rubric document');
    this.name = 'ResolvedRubricDocumentError';
  }
}

export function canonicalizeResolvedRubricDocument(untrusted: unknown): {
  document: z.infer<typeof DocumentSchema>;
  json: string;
  contentHash: string;
} {
  const parsed = DocumentSchema.safeParse(untrusted);
  if (!parsed.success) throw new ResolvedRubricDocumentError();
  let document: z.infer<typeof DocumentSchema>;
  try {
    document = DocumentSchema.parse(normalize(parsed.data));
  } catch {
    throw new ResolvedRubricDocumentError();
  }
  const json = canonicalJson(document);
  return { document, json, contentHash: createHash('sha256').update(json).digest('hex') };
}
