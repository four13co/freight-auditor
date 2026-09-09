import type pg from 'pg';
import type { ParsedInvoice } from './charge-fact.js';
import { evaluateInvoice, type AuditResult } from '../evaluator/evaluate-invoice.js';
import { CONTRACT_RUBRIC } from '../rubric-resolver/contract-rubric.js';
import { STANDARD_RUBRIC } from '../rubric-resolver/standard-rubric.js';
import { lookupContractRate } from '../rate-engine/rate-lookup.js';
import { detectDuplicateInvoice } from './duplicate-invoice.js';
import { resolveShipmentReferenceMatch } from './shipment-reference.js';

export interface ResolveAndEvaluateResult {
  result: AuditResult;
  resolvedInputs: Record<string, unknown>;
}

/**
 * 86e367qyq: the resolve-then-evaluate sequence shared verbatim by
 * ingestInvoice() (EDI path) and confirmInvoiceDraft() (PDF path) --
 * resolve duplicateInvoice/shipmentReferenceMatch, then CONTRACT_RUBRIC
 * with a resolved linehaul rate when contractVersionId is supplied,
 * STANDARD_RUBRIC-only otherwise. A rate-lookup miss is passed through
 * honestly as linehaulRate: null (the evaluator turns that into
 * UNASSESSABLE, never a guessed rate).
 */
export async function resolveAndEvaluate(
  client: pg.PoolClient,
  clientId: string,
  invoice: ParsedInvoice,
  contractVersionId?: string,
): Promise<ResolveAndEvaluateResult> {
  const duplicateInvoice = await detectDuplicateInvoice(
    client, clientId, invoice.invoiceNumber, invoice.transactionSet,
  );
  const shipmentReferenceMatch = await resolveShipmentReferenceMatch(client, clientId, invoice.shipmentReferences);
  let resolvedInputs: Record<string, unknown> = { duplicateInvoice, shipmentReferenceMatch };
  let result: AuditResult;
  if (contractVersionId) {
    const rate = await lookupContractRate(client, contractVersionId, 'LINEHAUL');
    resolvedInputs = { ...resolvedInputs, linehaulRate: rate };
    result = evaluateInvoice(invoice, CONTRACT_RUBRIC, { linehaulRate: rate, duplicateInvoice, shipmentReferenceMatch });
  } else {
    result = evaluateInvoice(invoice, STANDARD_RUBRIC, { duplicateInvoice, shipmentReferenceMatch });
  }
  return { result, resolvedInputs };
}
