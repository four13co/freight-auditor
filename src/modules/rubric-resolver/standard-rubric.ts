import type { AstNode } from '../rule-engine/ast.js';

/**
 * The hand-authored STANDARD-tier rubric (Master Spec §3, §5). This is the only
 * tier in Phase 1 — no CLIENT/CONTRACT tiers, no AI authoring, no cascade. Each
 * criterion is born hard (FIRM_RULE) and STANDARD.
 *
 * A criterion is either GATING (a hard gate — failure rejects the invoice back
 * to the carrier) or SCORING (produces a per-criterion conformance/variance
 * observation). The rule bodies are declarative ASTs (never JS), evaluated by
 * the pure interpreter against a resolved fact bundle.
 */

export type CriterionKind = 'GATING' | 'SCORING';

export interface StandardCriterion {
  criterionKey: string;
  kind: CriterionKind;
  description: string;
  /** Ordered so the composed rubric hashes deterministically. */
  evalOrder: number;
  ast: AstNode;
  /** The kickback/citation text used when a GATING criterion fails. */
  citation?: string;
}

/**
 * The composed rubric = an ordered list of criteria + a resolver version. The
 * content hash of this structure is what pins an audit_run for reproducibility.
 */
export interface ComposedRubric {
  resolverVersion: string;
  criteria: StandardCriterion[];
}

export const RESOLVER_VERSION = 'standard-resolver-v1';
export const ENGINE_SPEC_VERSION = 'engine-v1';

/**
 * Footing tolerance (§5): the reconciled triple B307 ≈ ΣL104 must foot within a
 * small absolute tolerance; carriers routinely violate it, so tolerance is a
 * criterion parameter, not a magic constant buried in code.
 */
export const FOOTING_TOLERANCE = '0.01';

export const STANDARD_RUBRIC: ComposedRubric = {
  resolverVersion: RESOLVER_VERSION,
  criteria: [
    // ---- GATING criteria (hard gates → REJECTED_REWORK on failure) ----------
    {
      criterionKey: 'STD.FOOTING',
      kind: 'GATING',
      evalOrder: 10,
      description: 'Declared invoice total foots to the sum of line charges within tolerance.',
      citation: 'Invoice total (B3-07) must equal the sum of billed line items (ΣL1-04).',
      ast: {
        type: 'require',
        key: 'declared_total',
        then: {
          type: 'compare',
          op: 'approx',
          tolerance: FOOTING_TOLERANCE,
          left: { type: 'fact', key: 'declared_total' },
          right: { type: 'fact', key: 'line_sum' },
        },
      },
    },
    {
      criterionKey: 'STD.CURRENCY_STATED',
      kind: 'GATING',
      evalOrder: 20,
      description: 'Every charge states a currency (never defaulted — critical for ocean/310).',
      citation: 'Each charge must state its currency (C3 / L1-20); defaulting is not permitted.',
      ast: {
        // all_currencies_stated is precomputed into the fact bundle as a bool.
        type: 'compare',
        op: 'eq',
        left: { type: 'fact', key: 'all_currencies_stated' },
        right: { type: 'lit', value: true },
      },
    },
    {
      criterionKey: 'STD.HAS_CHARGES',
      kind: 'GATING',
      evalOrder: 30,
      description: 'Invoice carries at least one charge line (required segment presence).',
      citation: 'Invoice must contain at least one billable charge line (L1).',
      ast: {
        type: 'compare',
        op: 'gt',
        left: { type: 'fact', key: 'charge_count' },
        right: { type: 'lit', value: 0 },
      },
    },
    // ---- SCORING criteria (per-criterion observations on a valid invoice) ----
    {
      criterionKey: 'STD.NO_QUARANTINED_CODES',
      kind: 'SCORING',
      evalOrder: 100,
      description: 'All charge codes resolved to a canonical category via the crosswalk.',
      ast: {
        type: 'compare',
        op: 'eq',
        left: { type: 'fact', key: 'quarantined_count' },
        right: { type: 'lit', value: 0 },
      },
    },
    {
      criterionKey: 'STD.FUEL_PRESENT',
      kind: 'SCORING',
      evalOrder: 110,
      description: 'A fuel surcharge is present (categorized FUEL via crosswalk, never by raw code).',
      ast: {
        type: 'compare',
        op: 'eq',
        left: { type: 'fact', key: 'has_fuel_category' },
        right: { type: 'lit', value: true },
      },
    },
  ],
};
