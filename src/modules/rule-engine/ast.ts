/**
 * Declarative predicate AST (Master Spec §3.2).
 *
 * Rules are stored as this JSON structure in `rule_version.ast` and evaluated by
 * an owned, pure interpreter — NEVER as raw JS run through `eval` (that would be
 * both an RCE vector and a determinism hazard). The AST is total: every node
 * evaluates to a value or an explicit UNASSESSABLE, never throws on missing data.
 *
 * The evaluated tree (each node annotated with the value it produced) IS the
 * human-readable explanation of a finding — no separate explanation channel.
 */

/** A money value carried as a decimal string + currency, or a plain number/bool/string. */
export type AstLiteral =
  | { type: 'lit'; value: number | string | boolean }
  | { type: 'money'; amount: string; currency: string };

/** Read a value out of the fact bundle by key (facts are resolved BEFORE eval). */
export interface AstFactRef {
  type: 'fact';
  key: string;
}

/** Arithmetic over money/number operands (decimal-safe). */
export interface AstArith {
  type: 'arith';
  op: 'add' | 'sub' | 'mul' | 'div' | 'abs';
  args: AstNode[];
}

/** Comparison → boolean. `approx` compares |a-b| <= tolerance (footing). */
export interface AstCompare {
  type: 'compare';
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'approx';
  left: AstNode;
  right: AstNode;
  tolerance?: string; // for approx: absolute tolerance as a decimal string
}

/** Boolean logic. */
export interface AstLogic {
  type: 'logic';
  op: 'and' | 'or' | 'not';
  args: AstNode[];
}

/** Marks a subtree unassessable when a required fact is absent. */
export interface AstRequire {
  type: 'require';
  key: string; // fact that must be present + non-empty
  then: AstNode;
}

export type AstNode =
  | AstLiteral
  | AstFactRef
  | AstArith
  | AstCompare
  | AstLogic
  | AstRequire;

/** A resolved fact bundle — the ONLY input to eval. No I/O or clock inside eval. */
export type FactBundle = Record<string, number | string | boolean | { amount: string; currency: string } | { decimal: string } | undefined>;
