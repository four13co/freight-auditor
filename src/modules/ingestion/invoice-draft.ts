import type pg from 'pg';
import type { ObjectStore } from '../reference-data/object-store.js';
import { storeSourceDocument } from '../reference-data/source-document.js';
import type { ParsedInvoice } from './charge-fact.js';
import {
  extractInvoiceFromPdf,
  defaultExtractInvoiceFromText,
  UnextractablePdfError,
  EXTRACTION_MODEL,
  type ExtractInvoiceFromTextImpl,
} from './pdf-extract.js';
import { matchCarrierName } from './carrier-match.js';
import { evaluateInvoice, type AuditResult } from '../evaluator/evaluate-invoice.js';
import { STANDARD_RUBRIC } from '../rubric-resolver/standard-rubric.js';
import { CONTRACT_RUBRIC } from '../rubric-resolver/contract-rubric.js';
import { persistAuditRun, type PersistedRun } from '../evaluator/persist.js';
import { lookupContractRate } from '../rate-engine/rate-lookup.js';
import { detectDuplicateInvoice } from './duplicate-invoice.js';
import { resolveShipmentReferenceMatch } from './shipment-reference.js';
import { z } from 'zod';

/**
 * 86e2xb911: the PDF invoice draft/confirm flow. A new, separate path from
 * ingestInvoice() (86e2v17u9) -- reuses evaluateInvoice()/persistAuditRun()
 * unchanged on confirm, per the item's own Solution and No-gos (does not
 * modify the EDI path).
 */

export class DraftNotFoundError extends Error {}
export class DraftAlreadyConfirmedError extends Error {}
export class DraftAlreadyFinalizedError extends Error {}
export class CarrierRequiredError extends Error {}

const CorrectedChargeSchema = z.object({
  code: z.string().optional(),
  x12Element: z.string().optional(),
  category: z.string().optional(),
  quarantined: z.boolean(),
  amount: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  currency: z.string().min(1),
  basis: z.string().optional(),
  rate: z.string().optional(),
  rawDescription: z.string().optional(),
  sourceLoop: z.string().optional(),
}).strict();

export const CorrectedInvoiceSchema = z.object({
  transactionSet: z.literal('PDF'),
  parserVersion: z.literal('pdf-llm-v1'),
  invoiceNumber: z.string().optional(),
  headerCurrency: z.string().optional(),
  charges: z.array(CorrectedChargeSchema).min(1),
  footing: z.object({
    declaredTotal: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
    lineSum: z.string().regex(/^-?\d+(\.\d+)?$/),
  }).strict().optional(),
  quarantinedCodes: z.array(z.string()),
}).strict();

export interface CreateDraftInput {
  clientId: string;
  pdfBytes: Buffer;
  contentType?: string;
}

export interface DraftRecord {
  id: string;
  status: 'extracted' | 'needs_carrier_review' | 'confirmed' | 'rejected';
  extractedPayload: ParsedInvoice;
  carrierCandidates: Array<{ carrierId: string; name: string }>;
}

/**
 * Accept a PDF, extract it via the LLM, attempt carrier resolution, and
 * store a draft. Never creates a real audit_run (AC1) -- confirmDraft is the
 * only path that does.
 */
export async function createInvoiceDraft(
  client: pg.PoolClient,
  store: ObjectStore,
  input: CreateDraftInput,
  // Explicitly defaulted here (rather than left to extractInvoiceFromPdf's
  // own default parameter) so an external caller -- notably a test using
  // vi.mock on pdf-extract.js -- can intercept the real LLM call through
  // this module's own import binding. A same-module default-parameter
  // self-reference inside pdf-extract.ts is NOT retargeted by vi.mock from
  // an external importer (verified: mocking pdf-extract.js and calling
  // extractInvoiceFromPdf(bytes) with no second arg still invokes the real
  // defaultExtractInvoiceFromText, because the default value expression
  // closes over pdf-extract.ts's own local scope, not a dynamically
  // re-resolved export) -- this is the seam that makes it interceptable.
  extractImpl: ExtractInvoiceFromTextImpl = defaultExtractInvoiceFromText,
): Promise<DraftRecord> {
  const doc = await storeSourceDocument(client, store, {
    clientId: input.clientId,
    bytes: input.pdfBytes,
    contentType: input.contentType,
  });

  // extractInvoiceFromPdf throws UnextractablePdfError for garbage/unreadable
  // input -- let it propagate; the route maps it to a 4xx (AC4), never a
  // partially-built draft.
  const { invoice, carrierName } = await extractInvoiceFromPdf(input.pdfBytes, extractImpl);
  const carrierMatch = await matchCarrierName(client, carrierName);

  const status = carrierMatch.carrierId === null && carrierMatch.candidates.length !== 1
    ? 'needs_carrier_review'
    : 'extracted';

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO invoice_draft (client_id, source_document_id, status, extracted_payload, carrier_candidates, resolved_carrier_id, extraction_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.clientId,
      doc.id,
      status,
      JSON.stringify(invoice),
      JSON.stringify(carrierMatch.candidates),
      carrierMatch.carrierId,
      EXTRACTION_MODEL,
    ],
  );

  return {
    id: inserted.rows[0]!.id,
    status,
    extractedPayload: invoice,
    carrierCandidates: carrierMatch.candidates,
  };
}

export interface ConfirmDraftInput {
  clientId: string;
  draftId: string;
  /** The full corrected invoice, when the analyst changed one or more fields. Omit to confirm as-extracted. */
  correctedPayload?: ParsedInvoice;
  /** Required when the draft's carrier is ambiguous (status needs_carrier_review) or the analyst is overriding the auto-match. */
  carrierId?: string;
  contractVersionId?: string;
}

export interface ConfirmDraftResult extends PersistedRun {
  auditRunId: string;
}

interface DraftRow {
  id: string;
  status: string;
  source_document_id: string;
  extracted_payload: ParsedInvoice;
  corrected_payload: ParsedInvoice | null;
  resolved_carrier_id: string | null;
}

async function loadDraft(client: pg.PoolClient, draftId: string): Promise<DraftRow> {
  const res = await client.query<DraftRow>(
    `SELECT id, status, source_document_id, extracted_payload, corrected_payload, resolved_carrier_id FROM invoice_draft WHERE id = $1`,
    [draftId],
  );
  const row = res.rows[0];
  if (!row) throw new DraftNotFoundError(`no invoice_draft with id ${draftId}`);
  return row;
}

/**
 * Confirm a draft: run the (possibly corrected) invoice through the existing
 * evaluate/persist pipeline, unchanged. Records the extraction/correction
 * diff into extraction_field (migration 0008) for every field the analyst
 * changed, so a future prompt-improvement effort has real data to train
 * against (the item's No-go: this item only captures the diff, does not
 * build that improvement mechanism).
 */
export async function confirmInvoiceDraft(
  client: pg.PoolClient,
  input: ConfirmDraftInput,
): Promise<ConfirmDraftResult> {
  const draft = await loadDraft(client, input.draftId);
  if (draft.status === 'confirmed') {
    throw new DraftAlreadyConfirmedError(`draft ${input.draftId} was already confirmed`);
  }
  if (draft.status === 'rejected') {
    throw new DraftAlreadyFinalizedError(`draft ${input.draftId} was already rejected`);
  }
  if (draft.status === 'needs_carrier_review' && !input.carrierId) {
    throw new CarrierRequiredError(`draft ${input.draftId} requires a carrierId before confirmation`);
  }

  const finalInvoice = input.correctedPayload
    ? {
        ...input.correctedPayload,
        transactionSet: draft.extracted_payload.transactionSet,
        parserVersion: draft.extracted_payload.parserVersion,
      }
    : draft.extracted_payload;

  if (input.correctedPayload) {
    await recordCorrectionDiff(client, {
      clientId: input.clientId,
      sourceDocumentId: draft.source_document_id,
      original: draft.extracted_payload,
      corrected: input.correctedPayload,
    });
  }

  let result: AuditResult;
  const duplicateInvoice = await detectDuplicateInvoice(
    client, input.clientId, finalInvoice.invoiceNumber, finalInvoice.transactionSet,
  );
  const shipmentReferenceMatch = await resolveShipmentReferenceMatch(client, input.clientId, finalInvoice.shipmentReferences);
  if (input.contractVersionId) {
    const rate = await lookupContractRate(client, input.contractVersionId, 'LINEHAUL');
    result = evaluateInvoice(finalInvoice, CONTRACT_RUBRIC, { linehaulRate: rate, duplicateInvoice, shipmentReferenceMatch });
  } else {
    result = evaluateInvoice(finalInvoice, STANDARD_RUBRIC, { duplicateInvoice, shipmentReferenceMatch });
  }

  const persisted = await persistAuditRun(client, {
    clientId: input.clientId,
    invoice: finalInvoice,
    result,
    rubricSnapshotId: null,
    carrierId: input.carrierId ?? draft.resolved_carrier_id ?? undefined,
  });

  await client.query(
    `UPDATE invoice_draft
       SET status = 'confirmed', corrected_payload = $1, confirmed_audit_run_id = $2, updated_at = now()
     WHERE id = $3`,
    [input.correctedPayload ? JSON.stringify(input.correctedPayload) : null, persisted.auditRunId, draft.id],
  );

  return persisted;
}

export async function rejectInvoiceDraft(
  client: pg.PoolClient,
  draftId: string,
): Promise<void> {
  const draft = await loadDraft(client, draftId);
  if (draft.status === 'confirmed' || draft.status === 'rejected') {
    throw new DraftAlreadyFinalizedError(`draft ${draftId} was already ${draft.status}`);
  }
  await client.query(
    `UPDATE invoice_draft SET status = 'rejected', updated_at = now() WHERE id = $1`,
    [draftId],
  );
}

// ParsedInvoice keys diffed as whole-value header fields (i.e. NOT the
// per-index charges handling below). Deliberately excludes transactionSet/
// parserVersion/quarantinedCodes -- these are structural/pipeline metadata
// the analyst never corrects, not extracted invoice content; diffing them
// would record noise, not a real correction.
const HEADER_FIELD_PATHS = ['invoiceNumber', 'headerCurrency', 'footing'] as const;

/**
 * Diff original vs. corrected invoice field-by-field and write one
 * extraction_field row per changed field -- durable capture (both the AI
 * value and the human correction), per the item's Solution (point 6: "Both
 * the raw LLM extraction AND the analyst's correction... are durably
 * stored"), which is stated generally, not scoped to charges only.
 *
 * Caught in review (PR #112): the original implementation only diffed
 * `charges`, so a correction that touched a header field (e.g. footing,
 * corrected alongside an amount so STD.FOOTING's approx-compare gate still
 * passes -- exactly what invoice-drafts-endpoint.db.test.ts's AC3 does) was
 * silently applied to the persisted audit run but never captured here. Now
 * diffs both the charges array (per-index) AND every field in
 * HEADER_FIELD_PATHS (whole-value).
 */
async function recordCorrectionDiff(
  client: pg.PoolClient,
  args: {
    clientId: string;
    sourceDocumentId: string;
    original: ParsedInvoice;
    corrected: ParsedInvoice;
  },
): Promise<void> {
  async function writeDiff(fieldPath: string, before: unknown, after: unknown): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await client.query(
      `INSERT INTO extraction_field (client_id, source_document_id, field_path, ai_value, human_value, model_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        args.clientId,
        args.sourceDocumentId,
        fieldPath,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
        EXTRACTION_MODEL,
      ],
    );
  }

  const maxLen = Math.max(args.original.charges.length, args.corrected.charges.length);
  for (let i = 0; i < maxLen; i++) {
    await writeDiff(`charges[${i}]`, args.original.charges[i], args.corrected.charges[i]);
  }

  for (const path of HEADER_FIELD_PATHS) {
    await writeDiff(path, args.original[path], args.corrected[path]);
  }
}

export { UnextractablePdfError };
