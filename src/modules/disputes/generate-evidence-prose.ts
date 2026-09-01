import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnthropicStructuredResult, VersionedAnthropicProvider, VersionedPrompt } from '../contracts/anthropic-provider.js';
import { rejectModelMoneyAuthority } from '../contracts/model-money-authority-gate.js';

export const EVIDENCE_PROSE_SCHEMA_VERSION = 'evidence-prose/1';
export const EVIDENCE_PROSE_PROMPT_VERSION = 'dispute-evidence-prose/1';

/**
 * The statement shape this module consumes -- structurally matches
 * EvidenceStatement from render-evidence-statement.ts (P4.C.4/#172,
 * unmerged) via a locally-declared interface rather than an import, same
 * cross-PR pattern as #172 used against #170.
 */
export interface EvidenceStatementInput {
  disputeLineId: string;
  amountLabel: string;
  varianceLabel: string | null;
  citations: Array<{ kind: string; reference: string; page: string | null }>;
  criterionKey: string;
}

const modelParagraphSchema = z.object({
  disputeLineId: z.string(),
  paragraph: z.string().trim().min(1).max(2_000),
  citedReferences: z.array(z.string()),
}).strict();

/** Retains suspicious model fields long enough for the money-authority gate to classify them before strict parsing. */
export const EvidenceProseProviderEnvelopeSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_PROSE_SCHEMA_VERSION),
  paragraphs: z.array(modelParagraphSchema).max(500),
}).passthrough();

export const EvidenceProseModelOutputSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_PROSE_SCHEMA_VERSION),
  paragraphs: z.array(modelParagraphSchema).max(500),
}).strict();

export interface EvidenceProse {
  schemaVersion: typeof EVIDENCE_PROSE_SCHEMA_VERSION;
  paragraphs: Array<{ disputeLineId: string; paragraph: string; citedReferences: string[] }>;
}

export const EVIDENCE_PROSE_PROMPT: VersionedPrompt = {
  version: EVIDENCE_PROSE_PROMPT_VERSION,
  system: [
    'Write one short, professional paragraph per dispute line explaining why the billed amount is disputed.',
    'Use ONLY the amount, variance, and citation references supplied for that line. Never invent, restate as fact,',
    'or recompute any number that was not given to you verbatim.',
    'Never emit arithmetic, money literals framed as new calculations, or authoritative financial fields --',
    'you are narrating evidence a deterministic system already produced, not calculating anything.',
    'Every paragraph must cite at least one of the reference strings supplied for its line, verbatim.',
    'Omit a line entirely when its evidence cannot be described without inventing information.',
  ].join(' '),
};

export class EvidenceProseError extends Error {
  constructor(readonly code: 'EMPTY_STATEMENTS' | 'UNCITED_PARAGRAPH' | 'UNKNOWN_LINE', message: string) {
    super(message); this.name = 'EvidenceProseError';
  }
}

/** Deterministic provenance binding for a set of statements: no single source document backs prose covering an entire dispute, so this hashes the statement content itself, mirroring how contract_rule_proposal binds to source_document_sha256. */
export function hashEvidenceStatements(statements: readonly EvidenceStatementInput[]): string {
  return createHash('sha256').update(JSON.stringify(statements)).digest('hex');
}

/**
 * Generates Claude-authored prose narrating already-rendered evidence
 * statements (P4.C.5). Every paragraph must cite at least one reference
 * string that was actually supplied for its line -- a paragraph citing
 * nothing supplied, or referencing an unknown dispute_line, is rejected
 * before it reaches the caller. Money-authority rejection
 * (model-money-authority-gate.ts, unchanged) runs first, exactly as it
 * does for contract rule proposals: this is narration, never a second
 * financial authority.
 */
export async function generateEvidenceProse(
  provider: VersionedAnthropicProvider,
  statements: readonly EvidenceStatementInput[],
): Promise<AnthropicStructuredResult<EvidenceProse>> {
  if (statements.length === 0) throw new EvidenceProseError('EMPTY_STATEMENTS', 'no evidence statements to narrate');

  const sourceDocumentSha256 = hashEvidenceStatements(statements);
  const providerResult = await provider.generateStructured({
    prompt: EVIDENCE_PROSE_PROMPT,
    outputSchema: EvidenceProseProviderEnvelopeSchema,
    sourceDocumentSha256,
    untrustedEvidence: JSON.stringify({ schemaVersion: EVIDENCE_PROSE_SCHEMA_VERSION, statements }),
  });

  rejectModelMoneyAuthority(providerResult.output);
  const safeOutput = EvidenceProseModelOutputSchema.parse(providerResult.output);

  const statementsByLine = new Map(statements.map((s) => [s.disputeLineId, s]));
  for (const paragraph of safeOutput.paragraphs) {
    const statement = statementsByLine.get(paragraph.disputeLineId);
    if (!statement) throw new EvidenceProseError('UNKNOWN_LINE', `paragraph cites unknown dispute line ${paragraph.disputeLineId}`);
    const allowedReferences = new Set(statement.citations.map((c) => c.reference));
    if (paragraph.citedReferences.length === 0 || !paragraph.citedReferences.some((r) => allowedReferences.has(r))) {
      throw new EvidenceProseError('UNCITED_PARAGRAPH', `paragraph for dispute line ${paragraph.disputeLineId} cites no supplied reference`);
    }
  }

  return { ...providerResult, output: safeOutput };
}
