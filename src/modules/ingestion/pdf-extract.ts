import { extractText, getDocumentProxy } from 'unpdf';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ParsedInvoice, NormalizedCharge } from './charge-fact.js';

/** Raised whenever the PDF or its extracted text can't be turned into a usable invoice. */
export class UnextractablePdfError extends Error {}

const PARSER_VERSION = 'pdf-llm-v1';
const EXTRACTION_MODEL = 'claude-opus-5';

// Mirrors NormalizedCharge (charge-fact.ts) minus `quarantined` -- the LLM
// never marks a charge quarantined itself (quarantining is a crosswalk-miss
// concept from the EDI path, per charge-fact.ts's own doc comment); every
// extracted charge here is treated as resolved by construction (category is
// optional -- the LLM may genuinely not know it, same honesty rule as EDI).
const ExtractedChargeSchema = z.object({
  code: z.string().optional(),
  category: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string(),
  rawDescription: z.string().optional(),
});

const ExtractedInvoiceSchema = z.object({
  carrierName: z.string().describe('The carrier or vendor name as printed on the invoice'),
  invoiceNumber: z.string().optional(),
  headerCurrency: z.string().optional(),
  declaredTotal: z.string().optional().describe('The invoice total as printed, if stated'),
  charges: z.array(ExtractedChargeSchema),
  extractable: z
    .boolean()
    .describe('false if the document is not a readable invoice (garbage, scanned image with no usable text, corrupted)'),
});

export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

/**
 * The LLM call, behind an injectable interface (this repo's established
 * pattern -- rollbackImpl, runImpl, triggerBuildImpl) so every draft-flow
 * test can inject a deterministic double and the real Anthropic call has
 * exactly one production call site. See the PR body for the scope-honesty
 * note this pattern requires: no test in this repo's suite exercises this
 * real implementation end to end (same shape as 86e2v2h0e's rollback
 * rehearsal note) -- it is unproven until someone runs it with a real key.
 */
export type ExtractInvoiceFromTextImpl = (pdfText: string) => Promise<ExtractedInvoice>;

export async function defaultExtractInvoiceFromText(pdfText: string): Promise<ExtractedInvoice> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    system:
      'You extract structured freight invoice data from raw PDF text. Money amounts are decimal strings, never floats. ' +
      'If the text is garbage, a scanned image with no extractable text, or otherwise not a usable invoice, set extractable to false ' +
      'and leave charges empty rather than guessing.',
    messages: [{ role: 'user', content: pdfText }],
    output_config: {
      format: zodOutputFormat(ExtractedInvoiceSchema),
    },
  });
  if (!response.parsed_output) {
    throw new UnextractablePdfError('LLM extraction did not return a parseable structured result');
  }
  return response.parsed_output;
}

function toNormalizedCharge(c: ExtractedInvoice['charges'][number]): NormalizedCharge {
  return {
    code: c.code,
    category: c.category,
    quarantined: false,
    amount: c.amount,
    currency: c.currency,
    rawDescription: c.rawDescription,
  };
}

/**
 * Extract PDF bytes -> a ParsedInvoice-shaped draft payload, ready to hand
 * to the existing evaluateInvoice()/persistAuditRun() pipeline once
 * confirmed. Throws UnextractablePdfError for anything the LLM can't
 * usefully read -- the route maps that to a 4xx, never a 500 or a
 * low-confidence draft presented as reliable (the item's AC4).
 */
export async function extractInvoiceFromPdf(
  pdfBytes: Buffer,
  extractImpl: ExtractInvoiceFromTextImpl = defaultExtractInvoiceFromText,
): Promise<{ invoice: ParsedInvoice; carrierName: string }> {
  let text: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
    const result = await extractText(pdf, { mergePages: true });
    text = result.text;
  } catch (err) {
    throw new UnextractablePdfError(
      `could not parse PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (text.trim().length === 0) {
    throw new UnextractablePdfError('PDF contains no extractable text (likely a scanned image)');
  }

  const extracted = await extractImpl(text);
  if (!extracted.extractable || extracted.charges.length === 0) {
    throw new UnextractablePdfError('LLM could not extract usable invoice data from this document');
  }

  const invoice: ParsedInvoice = {
    transactionSet: 'PDF',
    parserVersion: PARSER_VERSION,
    invoiceNumber: extracted.invoiceNumber,
    headerCurrency: extracted.headerCurrency,
    charges: extracted.charges.map(toNormalizedCharge),
    footing: extracted.declaredTotal
      ? {
          declaredTotal: extracted.declaredTotal,
          lineSum: extracted.charges
            .reduce((sum, c) => sum + (c.amount ? Number(c.amount) : 0), 0)
            .toFixed(4),
        }
      : undefined,
    quarantinedCodes: [],
  };

  return { invoice, carrierName: extracted.carrierName };
}

export { EXTRACTION_MODEL };
