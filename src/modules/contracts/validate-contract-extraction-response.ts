import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ContractExtractionSchema, type ContractExtraction,
} from './contract-extraction-schema.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const pinsSchema = z.object({
  provider: z.literal('anthropic'),
  modelId: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(200),
  sourceDocumentSha256: sha256,
}).strict();
const responseEnvelopeSchema = pinsSchema.extend({
  output: z.unknown().refine((output) => output !== undefined, 'model output is required'),
}).strict();

export type ContractExtractionPins = z.infer<typeof pinsSchema>;
export interface ValidatedContractExtractionResponse {
  extraction: ContractExtraction;
  idempotencyKey: string;
}

export type ContractExtractionValidationErrorCode = 'INVALID_RESPONSE_ENVELOPE' | 'PIN_MISMATCH' | 'INVALID_EXTRACTION';
export class ContractExtractionValidationError extends Error {
  constructor(readonly code: ContractExtractionValidationErrorCode, message: string) {
    super(message); this.name = 'ContractExtractionValidationError';
  }
}

/** Validates trusted adapter metadata and model output before any persistence boundary is crossed. */
export function validateContractExtractionResponse(
  untrustedResponse: unknown,
  untrustedExpectedPins: ContractExtractionPins,
): ValidatedContractExtractionResponse {
  const expected = pinsSchema.parse(untrustedExpectedPins);
  const envelope = responseEnvelopeSchema.safeParse(untrustedResponse);
  if (!envelope.success) {
    throw new ContractExtractionValidationError('INVALID_RESPONSE_ENVELOPE', 'contract extraction response envelope is invalid');
  }
  for (const key of ['provider', 'modelId', 'promptVersion', 'sourceDocumentSha256'] as const) {
    if (envelope.data[key] !== expected[key]) {
      throw new ContractExtractionValidationError('PIN_MISMATCH', `contract extraction response ${key} does not match the trusted pin`);
    }
  }
  const parsed = ContractExtractionSchema.safeParse(envelope.data.output);
  if (!parsed.success) {
    throw new ContractExtractionValidationError('INVALID_EXTRACTION', 'contract extraction output failed schema validation');
  }
  if (parsed.data.model.provider !== expected.provider || parsed.data.model.modelId !== expected.modelId
    || parsed.data.model.promptVersion !== expected.promptVersion || parsed.data.sourceDocumentSha256 !== expected.sourceDocumentSha256) {
    throw new ContractExtractionValidationError('PIN_MISMATCH', 'contract extraction output metadata does not match the trusted pin');
  }
  return { extraction: parsed.data, idempotencyKey: contractExtractionIdempotencyKey(parsed.data) };
}

export function contractExtractionIdempotencyKey(extraction: ContractExtraction): string {
  const parsed = ContractExtractionSchema.parse(extraction);
  return createHash('sha256').update(stableStringify(parsed)).digest('hex');
}

/** The only supported handoff to persistence: invalid responses can never invoke the callback. */
export async function persistValidatedContractExtraction<Result>(
  untrustedResponse: unknown,
  expectedPins: ContractExtractionPins,
  persist: (extraction: ContractExtraction, idempotencyKey: string) => Promise<Result>,
): Promise<{ idempotencyKey: string; result: Result }> {
  const validated = validateContractExtractionResponse(untrustedResponse, expectedPins);
  const result = await persist(validated.extraction, validated.idempotencyKey);
  return { idempotencyKey: validated.idempotencyKey, result };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
