import { z } from 'zod';
import type { RubricTier } from './select-applicable-rubrics.js';

export const RUBRIC_FOLD_VERSION = 'rubric-tier-fold-v1';
const TIERS: readonly RubricTier[] = ['STANDARD', 'CLIENT', 'CONTRACT'];
const VerbSchema = z.enum(['INHERIT', 'ADD', 'REPLACE', 'TIGHTEN', 'EXEMPT']);
const LayerSchema = z.object({
  tier: z.enum(TIERS),
  rubricId: z.string().uuid(),
  rubricVersionId: z.string().uuid(),
  memberships: z.array(z.object({
    criterionKey: z.string().trim().min(1),
    criterionVersionId: z.string().uuid().nullable(),
    overrideVerb: VerbSchema,
    overridePayload: z.unknown().optional(),
    evalOrder: z.number().int(),
  }).strict()),
}).strict();

export type RubricLayer = z.infer<typeof LayerSchema>;
export interface FoldedCriterionOperations {
  criterionKey: string;
  operations: Array<RubricLayer['memberships'][number] & {
    tier: RubricTier;
    rubricVersionId: string;
  }>;
}

export class RubricFoldInputError extends Error {
  readonly code = 'RUBRIC_FOLD_INVALID';
  constructor(message = 'Invalid rubric tier fold input') {
    super(message);
    this.name = 'RubricFoldInputError';
  }
}

/** Build the deterministic cascade; verb semantics are applied by later stages. */
export function foldRubricTiers(untrustedLayers: unknown): readonly FoldedCriterionOperations[] {
  const parsed = z.array(LayerSchema).safeParse(untrustedLayers);
  if (!parsed.success) throw new RubricFoldInputError();
  const layers = [...parsed.data].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  if (new Set(layers.map((layer) => layer.tier)).size !== layers.length) {
    throw new RubricFoldInputError('Multiple selected rubric versions for one tier');
  }

  const grouped = new Map<string, FoldedCriterionOperations['operations']>();
  for (const layer of layers) {
    const memberships = [...layer.memberships].sort((a, b) =>
      a.evalOrder - b.evalOrder || a.criterionKey.localeCompare(b.criterionKey));
    for (const membership of memberships) {
      const operations = grouped.get(membership.criterionKey) ?? [];
      operations.push({ ...membership, tier: layer.tier, rubricVersionId: layer.rubricVersionId });
      grouped.set(membership.criterionKey, operations);
    }
  }
  return [...grouped.entries()]
    .map(([criterionKey, operations]) => ({ criterionKey, operations }))
    .sort((a, b) => {
      const aOrder = Math.min(...a.operations.map((operation) => operation.evalOrder));
      const bOrder = Math.min(...b.operations.map((operation) => operation.evalOrder));
      return aOrder - bOrder || a.criterionKey.localeCompare(b.criterionKey);
    });
}
