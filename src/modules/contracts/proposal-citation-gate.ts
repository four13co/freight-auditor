import { z } from 'zod';
import { ClauseNormalizationSchema, ExtractionCitationSchema, type ClauseNormalization } from './clause-normalization.js';

type Citation = z.infer<typeof ExtractionCitationSchema>;
export type ProposalCitationRejectionCode = 'MISSING_CLAUSE_REFERENCE' | 'MISSING_CITATION' |
  'UNKNOWN_CLAUSE' | 'ABSTAINED_CLAUSE' | 'UNCITED_CLAUSE' | 'UNKNOWN_CITATION';

export interface ProposalCitationRejection {
  criterionKey: string;
  code: ProposalCitationRejectionCode;
  clauseReference: string | null;
}

interface CitationCandidate {
  criteria: Array<{ criterionKey: string; clauseReferences: string[]; citations: Citation[] }>;
}

export interface ProposalCitationGateResult {
  accepted: boolean;
  rejections: ProposalCitationRejection[];
}

/** Pure fail-closed gate run before proposal enrichment, persistence, or review. */
export function validateProposalCitations(
  candidate: CitationCandidate,
  normalization: ClauseNormalization,
): ProposalCitationGateResult {
  const verified = ClauseNormalizationSchema.parse(normalization);
  const clauses = new Map(verified.clauses.map((clause) => [canonicalReference(clause.clauseReference), clause]));
  const rejections: ProposalCitationRejection[] = [];
  for (const criterion of [...candidate.criteria].sort((left, right) => left.criterionKey.localeCompare(right.criterionKey))) {
    if (!criterion.clauseReferences.length) reject(rejections, criterion.criterionKey, 'MISSING_CLAUSE_REFERENCE', null);
    if (!criterion.citations.length) reject(rejections, criterion.criterionKey, 'MISSING_CITATION', null);
    const allowed = new Set<string>();
    for (const reference of [...new Set(criterion.clauseReferences.map(canonicalReference))].sort()) {
      const clause = clauses.get(reference);
      if (!clause) { reject(rejections, criterion.criterionKey, 'UNKNOWN_CLAUSE', reference); continue; }
      if (clause.status === 'ABSTAINED') { reject(rejections, criterion.criterionKey, 'ABSTAINED_CLAUSE', clause.clauseReference); continue; }
      const clauseCitations = new Set(clause.citations.map(citationKey));
      clauseCitations.forEach((key) => allowed.add(key));
      if (!criterion.citations.some((citation) => clauseCitations.has(citationKey(citation)))) {
        reject(rejections, criterion.criterionKey, 'UNCITED_CLAUSE', clause.clauseReference);
      }
    }
    for (const citation of criterion.citations) {
      if (!allowed.has(citationKey(citation))) reject(rejections, criterion.criterionKey, 'UNKNOWN_CITATION', null);
    }
  }
  return { accepted: rejections.length === 0, rejections };
}

export class ProposalCitationError extends Error {
  readonly code = 'UNCITED_PROPOSAL';
  constructor(readonly rejections: ProposalCitationRejection[]) {
    super('one or more proposed criteria lack complete source citations'); this.name = 'ProposalCitationError';
  }
}

export function requireProposalCitations(candidate: CitationCandidate, normalization: ClauseNormalization): void {
  const result = validateProposalCitations(candidate, normalization);
  if (!result.accepted) throw new ProposalCitationError(result.rejections);
}

function reject(target: ProposalCitationRejection[], criterionKey: string,
  code: ProposalCitationRejectionCode, clauseReference: string | null): void {
  target.push({ criterionKey, code, clauseReference });
}
function canonicalReference(value: string): string { return value.normalize('NFKC').toLowerCase(); }
function citationKey(citation: Citation): string {
  return JSON.stringify([citation.pageNumber, citation.excerpt, citation.boundingBox ?? null,
    citation.span ? [citation.span.offset, citation.span.length] : null]);
}
