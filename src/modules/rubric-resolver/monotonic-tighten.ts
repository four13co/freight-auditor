import { Decimal } from 'decimal.js';
import type { AstCompare, AstNode } from '../rule-engine/ast.js';

export const TIGHTEN_PROVER_VERSION = 'monotonic-tighten-v1';

export type TightenProof =
  | { monotonic: true; proof: 'IDENTICAL' | 'NARROWER_BOUND' | 'NARROWER_TOLERANCE' | 'ADDED_CONJUNCTS' }
  | { monotonic: false; reason: 'UNSUPPORTED_SHAPE' | 'OPERAND_CHANGED' | 'BOUND_WEAKENED' | 'CLAUSE_REMOVED' };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function numericLiteral(node: AstNode): Decimal | null {
  if (node.type !== 'lit' || (typeof node.value !== 'number' && typeof node.value !== 'string')) return null;
  try { return new Decimal(node.value); } catch { return null; }
}

function proveCompare(base: AstCompare, tightened: AstCompare): TightenProof {
  if (base.op !== tightened.op || canonical(base.left) !== canonical(tightened.left)) {
    return { monotonic: false, reason: 'OPERAND_CHANGED' };
  }
  if (base.op === 'approx') {
    if (canonical(base.right) !== canonical(tightened.right)) return { monotonic: false, reason: 'OPERAND_CHANGED' };
    try {
      const before = new Decimal(base.tolerance ?? '0');
      const after = new Decimal(tightened.tolerance ?? '0');
      return after.lte(before)
        ? { monotonic: true, proof: after.eq(before) ? 'IDENTICAL' : 'NARROWER_TOLERANCE' }
        : { monotonic: false, reason: 'BOUND_WEAKENED' };
    } catch { return { monotonic: false, reason: 'UNSUPPORTED_SHAPE' }; }
  }
  const before = numericLiteral(base.right);
  const after = numericLiteral(tightened.right);
  if (!before || !after) return { monotonic: false, reason: 'UNSUPPORTED_SHAPE' };
  const safe = base.op === 'lt' || base.op === 'lte' ? after.lte(before)
    : base.op === 'gt' || base.op === 'gte' ? after.gte(before)
      : after.eq(before);
  if (!safe) return { monotonic: false, reason: 'BOUND_WEAKENED' };
  return { monotonic: true, proof: after.eq(before) ? 'IDENTICAL' : 'NARROWER_BOUND' };
}

/** Prove that every passing result under `tightened` also passed under `base`. */
export function proveMonotonicTighten(base: AstNode, tightened: AstNode): TightenProof {
  if (canonical(base) === canonical(tightened)) return { monotonic: true, proof: 'IDENTICAL' };
  if (base.type === 'compare' && tightened.type === 'compare') return proveCompare(base, tightened);
  if (base.type === 'logic' && tightened.type === 'logic' && base.op === 'and' && tightened.op === 'and') {
    const nextClauses = new Set(tightened.args.map(canonical));
    return base.args.every((clause) => nextClauses.has(canonical(clause)))
      ? { monotonic: true, proof: 'ADDED_CONJUNCTS' }
      : { monotonic: false, reason: 'CLAUSE_REMOVED' };
  }
  return { monotonic: false, reason: 'UNSUPPORTED_SHAPE' };
}
