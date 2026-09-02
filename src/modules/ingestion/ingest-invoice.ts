import type pg from 'pg';
import type { ObjectStore } from '../reference-data/object-store.js';
import { storeSourceDocument } from '../reference-data/source-document.js';
import { parseX12, segmentsByTag, firstSegment, el, X12ParseError } from './x12.js';
import { parse210 } from './parse-210.js';
import { parse310 } from './parse-310.js';
import { resolveChargeCode } from '../reference-data/crosswalk.js';
import type { Categorize } from './charge-fact.js';
import { evaluateInvoice, type AuditResult } from '../evaluator/evaluate-invoice.js';
import { CONTRACT_RUBRIC } from '../rubric-resolver/contract-rubric.js';
import { STANDARD_RUBRIC } from '../rubric-resolver/standard-rubric.js';
import { persistAuditRun, type PersistedRun } from '../evaluator/persist.js';
import { lookupContractRate } from '../rate-engine/rate-lookup.js';
import { detectDuplicateInvoice } from './duplicate-invoice.js';
import { resolveShipmentReferenceMatch } from './shipment-reference.js';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

/**
 * 86e2v17u9: the raw-EDI-to-audit-run orchestration the item's Solution
 * section describes, extracted into its own module (the item's own
 * suggestion) rather than inlined in the route handler.
 *
 * carrierId/contractVersionId are BOTH intentionally optional and
 * independent (Greg's DECISION comment, 2026-08-20, on this task): the
 * caller is expected to already know which carrier/contract an invoice
 * belongs to for a CONTRACT-scoped run (option b) -- no X12-envelope
 * extraction (option a, deferred as a fallback) and no "the tenant's one
 * active contract" inference (option c, explicitly rejected as fragile).
 * Passing neither runs the STANDARD_RUBRIC-only path, which is correct,
 * honest engine behavior for an invoice with no contract context, not a
 * degraded case.
 */
export interface IngestInvoiceInput {
  clientId: string;
  rawBytes: Buffer;
  contentType?: string;
  contractVersionId?: string;
}

export interface IngestInvoiceResult {
  auditRunId: string;
  invoiceId: string;
  outcome: AuditResult['outcome'];
}

export class UnparseableEdiError extends Error {}

/**
 * 86e32tg6n: build the real, DB-backed categorize callback for this raw EDI
 * document -- replaces the stub 4-code map (stub-crosswalk.ts), which is now
 * test-fixture-only.
 *
 * `categorize` (charge-fact.ts's `Categorize`) is a synchronous callback --
 * parse210/parse310 invoke it inline while walking the L1 loop, so it can't
 * itself go async without rippling that change through every parser test
 * (all ~20 call sites pass a plain sync function). Instead we resolve
 * everything the parse will need up front, synchronously from that point on:
 *
 *   1. The carrier, if the EDI declares one (B3-11 SCAC, 210 only -- 310 has
 *      no per-invoice carrier field in this scheme). Unmatched/absent SCAC
 *      resolves to carrierId: null, which resolveChargeCode's own query
 *      already treats as "global rows only", never a guess.
 *   2. Every distinct raw charge code the L1 loop will see (a second,
 *      trivial read of the same segments buildCharges will iterate --
 *      cheap, and keeps parse210/parse310's signatures untouched).
 *   3. One resolveChargeCode call per distinct code (client/carrier
 *      precedence, §6.2), collapsed into a plain code -> category map so the
 *      callback itself stays synchronous.
 */
async function resolveCategorizer(
  client: pg.PoolClient,
  raw: string,
  transactionSet: '210' | '310',
): Promise<Categorize> {
  const ix = parseX12(raw);

  const carrierCode = transactionSet === '210' ? el(firstSegment(ix, 'B3'), 11) : undefined;
  let carrierId: string | null = null;
  if (carrierCode) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM carrier WHERE scac_code = $1`,
      [carrierCode.trim()],
    );
    carrierId = rows[0]?.id ?? null;
  }

  const codes = new Set<string>();
  for (const l1 of segmentsByTag(ix, 'L1')) {
    const code = el(l1, 8); // L1-08 = special charge code, same element buildCharges reads
    if (code !== undefined) codes.add(code);
  }

  const categoryByCode = new Map<string, string | undefined>();
  await Promise.all(
    [...codes].map(async (code) => {
      const match = await resolveChargeCode(client, { carrierId, sourceCode: code });
      categoryByCode.set(code, match?.canonicalCategory);
    }),
  );

  return (code) => (code === undefined ? undefined : categoryByCode.get(code));
}

/**
 * ST01-based transaction-set detection (the item's own rabbit-hole guard:
 * a minimal heuristic is sufficient, not a general X12 router). Reads the
 * interchange once for detection; parse210/parse310 each re-parse the raw
 * bytes internally via parseEdiEnvelope -- cheap, and keeps both parsers
 * self-contained rather than threading a pre-parsed interchange through a
 * new shared signature.
 */
function detectTransactionSet(raw: string): '210' | '310' {
  const ix = parseX12(raw);
  const st01 = el(firstSegment(ix, 'ST'), 1);
  if (st01 === '210') return '210';
  if (st01 === '310') return '310';
  throw new UnparseableEdiError(
    `unrecognized or missing ST01 transaction-set code: ${st01 ?? '(none)'}`,
  );
}

export async function ingestInvoice(
  client: pg.PoolClient,
  store: ObjectStore,
  input: IngestInvoiceInput,
): Promise<IngestInvoiceResult> {
  const raw = input.rawBytes.toString('utf8');

  // 1. Immutable raw-bytes storage (reused as-is, per the item's Solution).
  const sourceDocument = await storeSourceDocument(client, store, {
    clientId: input.clientId,
    bytes: input.rawBytes,
    contentType: input.contentType,
  });
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, sourceDocument.id, 'ingestion.source_stored'),
    clientId: input.clientId,
    entity: 'source_document',
    entityId: sourceDocument.id,
    event: 'ingestion.source_stored',
    actorKind: 'system',
    detail: { contentType: input.contentType ?? null, sha256: sourceDocument.sha256 },
  });

  // 2. Transaction-set detection + matching parser. A parse failure (garbage
  // bytes, an X12ParseError from deep inside parse210/parse310, or an
  // unrecognized ST01) is surfaced as the same 4xx-worthy error type --
  // never a 500, per the item's malformed-input requirement.
  let transactionSet: '210' | '310';
  try {
    transactionSet = detectTransactionSet(raw);
  } catch (err) {
    if (err instanceof X12ParseError) {
      throw new UnparseableEdiError(err.message);
    }
    throw err;
  }

  // A GS01 functional-group mismatch (edi-envelope.ts's parseEdiEnvelope)
  // throws a plain Error, not X12ParseError -- both are equally "this isn't
  // parseable per the ST01 we just detected," so both map to the same 4xx.
  // Nothing else in parse210/parse310's call graph throws (verified: no
  // other `throw` site in either file or their shared edi-envelope.ts
  // helpers besides X12ParseError's own throws and this one), so catching
  // Error broadly here doesn't also swallow a genuine backend fault.
  const categorize = await resolveCategorizer(client, raw, transactionSet);
  let invoice;
  try {
    invoice = transactionSet === '210' ? parse210(raw, categorize) : parse310(raw, categorize);
  } catch (err) {
    if (err instanceof Error) {
      throw new UnparseableEdiError(err.message);
    }
    throw err;
  }

  // 3. Evaluate -- CONTRACT_RUBRIC + resolved rate when a contractVersionId
  // is supplied (option b); STANDARD_RUBRIC-only otherwise. A rate-lookup
  // miss (contractVersionId given but no matching contract_rate row) is
  // reported honestly as linehaulRate: null -- the evaluator turns that into
  // UNASSESSABLE, never a guessed/defaulted rate (rate-lookup.ts's own
  // contract).
  let result: AuditResult;
  const duplicateInvoice = await detectDuplicateInvoice(
    client, input.clientId, invoice.invoiceNumber, invoice.transactionSet,
  );
  const shipmentReferenceMatch = await resolveShipmentReferenceMatch(client, input.clientId, invoice.shipmentReferences);
  let resolvedInputs: Record<string, unknown> = { duplicateInvoice, shipmentReferenceMatch };
  if (input.contractVersionId) {
    const rate = await lookupContractRate(client, input.contractVersionId, 'LINEHAUL');
    resolvedInputs = { ...resolvedInputs, linehaulRate: rate };
    result = evaluateInvoice(invoice, CONTRACT_RUBRIC, { linehaulRate: rate, duplicateInvoice, shipmentReferenceMatch });
  } else {
    result = evaluateInvoice(invoice, STANDARD_RUBRIC, { duplicateInvoice, shipmentReferenceMatch });
  }

  // 4. Persist (variance_finding derivation already lives inside
  // persistAuditRun, 86e2v17p5 -- this item only calls it, per its own
  // rabbit-hole guard against touching persist internals).
  const persisted: PersistedRun = await persistAuditRun(client, {
    clientId: input.clientId,
    invoice,
    result,
    rubricSnapshotId: null,
    sourceDocuments: [{ id: sourceDocument.id, sha256: sourceDocument.sha256 }],
    contractVersionIds: input.contractVersionId ? [input.contractVersionId] : [],
    resolvedInputs,
  });
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, persisted.auditRunId, 'ingestion.audit_created'),
    clientId: input.clientId,
    entity: 'audit_run',
    entityId: persisted.auditRunId,
    event: 'ingestion.audit_created',
    actorKind: 'system',
    detail: { invoiceId: persisted.invoiceId, outcome: result.outcome, transactionSet },
  });

  return { auditRunId: persisted.auditRunId, invoiceId: persisted.invoiceId, outcome: result.outcome };
}
