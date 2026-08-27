import { z } from 'zod';

export const correctionJsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(correctionJsonValue), z.record(z.string(), correctionJsonValue),
]));

export const ExtractionFieldCorrectionInputSchema = z.object({
  human_value: correctionJsonValue,
  answer_source: z.enum(['read_from_doc', 'analyst_knowledge', 'carrier_confirmed']),
}).strict();

export type ExtractionFieldCorrectionInput = z.infer<typeof ExtractionFieldCorrectionInputSchema>;

export class ExtractionFieldNotFoundError extends Error {
  readonly code = 'EXTRACTION_FIELD_NOT_FOUND';
  constructor() { super('Extraction field not found'); this.name = 'ExtractionFieldNotFoundError'; }
}

export class ExtractionFieldCorrectionConflictError extends Error {
  readonly code = 'EXTRACTION_FIELD_CORRECTION_CONFLICT';
  constructor() { super('Correction identity is already bound to different evidence'); this.name = 'ExtractionFieldCorrectionConflictError'; }
}
