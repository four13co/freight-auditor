import { z } from 'zod';

export const FinalizeContractVersionInputSchema = z.object({
  extraction_response_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export class ContractVersionFinalizationError extends Error {
  constructor(readonly code: 'CONTRACT_VERSION_NOT_FOUND' | 'EXTRACTION_NOT_FOUND' | 'UNANSWERED_CLARIFICATIONS' | 'FINALIZATION_CONFLICT') {
    super(code.toLowerCase().replace(/_/g, ' ')); this.name = 'ContractVersionFinalizationError';
  }
}
