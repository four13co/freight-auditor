import { Decimal } from 'decimal.js';
import type { DefensibilityChain } from '../findings/get-defensibility-chain.js';

/**
 * Pure deterministic rendering of one evidence-packet line into a
 * structured statement carrying its amount, computation, and citation
 * (P4.C.4). Consumes the SAME shape buildEvidencePacket produces
 * (P4.C.3/#170, unmerged) via a locally-declared interface rather than
 * importing that module directly -- this keeps the two PRs mergeable in
 * either order (matching this session's parameter-not-import precedent
 * for other cross-PR dependencies) since the shape, not the module, is the
 * actual contract between them.
 *
 * "Inject" means: substitute the packet's own stored numbers and
 * citations into a fixed statement template -- no AI, no free text
 * generation, no numbers computed here that aren't already present on the
 * chain. Claude-authored connective prose around this statement (P4.C.5)
 * is a later item that wraps this output; it never replaces or recomputes
 * any of it.
 */
export interface RenderableEvidenceLine {
  disputeLineId: string;
  amount: string | null;
  currency: string | null;
  defensibilityChain: DefensibilityChain;
}

export interface CitationRef {
  kind: 'clause' | 'rate_cell' | 'source_document';
  reference: string;
  page: string | null;
}

export interface EvidenceStatement {
  disputeLineId: string;
  amountLabel: string;
  varianceLabel: string | null;
  citations: CitationRef[];
  criterionKey: string;
}

export class RenderEvidenceStatementError extends Error {
  constructor(readonly code: 'MISSING_AMOUNT_CURRENCY' | 'NO_CITATION') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'RenderEvidenceStatementError';
  }
}

function formatAmount(amount: string, currency: string): string {
  return `${new Decimal(amount).toFixed(2)} ${currency}`;
}

/**
 * Renders one line. Requires the line to carry a resolvable amount +
 * currency and at least one citation (clause, rate cell, or source
 * document) -- a line whose evidence chain has none of the three cannot be
 * defended and must not be silently rendered as if it could.
 */
export function renderEvidenceStatement(line: RenderableEvidenceLine): EvidenceStatement {
  if (line.amount === null || line.currency === null) {
    throw new RenderEvidenceStatementError('MISSING_AMOUNT_CURRENCY');
  }

  const chain = line.defensibilityChain;
  const citations: CitationRef[] = [];
  if (chain.clause) citations.push({ kind: 'clause', reference: chain.clause.reference, page: chain.clause.page });
  if (chain.rateCell) citations.push({ kind: 'rate_cell', reference: chain.rateCell.reference, page: null });
  if (chain.sourceDocument) {
    citations.push({ kind: 'source_document', reference: chain.sourceDocument.sha256, page: null });
  }
  if (citations.length === 0) throw new RenderEvidenceStatementError('NO_CITATION');

  const varianceLabel = chain.finding.varianceAmount && chain.finding.currency
    ? formatAmount(chain.finding.varianceAmount, chain.finding.currency)
    : null;

  return {
    disputeLineId: line.disputeLineId,
    amountLabel: formatAmount(line.amount, line.currency),
    varianceLabel,
    citations,
    criterionKey: chain.criterion.key,
  };
}

/**
 * Renders every line of a packet-like set, in the order given (the caller
 * -- buildEvidencePacket -- already orders lines by dispute_line.id for
 * determinism; this never re-sorts).
 */
export function renderEvidenceStatements(lines: readonly RenderableEvidenceLine[]): EvidenceStatement[] {
  return lines.map(renderEvidenceStatement);
}
