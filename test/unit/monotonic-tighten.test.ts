import { describe, expect, it } from 'vitest';
import { proveMonotonicTighten } from '../../src/modules/rubric-resolver/monotonic-tighten.js';
import type { AstNode } from '../../src/modules/rule-engine/ast.js';

const upper = (value: number): AstNode => ({
  type: 'compare', op: 'lte', left: { type: 'fact', key: 'variance' }, right: { type: 'lit', value },
});
const lower = (value: number): AstNode => ({
  type: 'compare', op: 'gte', left: { type: 'fact', key: 'weight' }, right: { type: 'lit', value },
});

describe('monotonic TIGHTEN semantics', () => {
  it('accepts narrower upper and lower bounds using decimal-safe comparison', () => {
    expect(proveMonotonicTighten(upper(10), upper(5))).toEqual({ monotonic: true, proof: 'NARROWER_BOUND' });
    expect(proveMonotonicTighten(lower(10), lower(12))).toEqual({ monotonic: true, proof: 'NARROWER_BOUND' });
  });

  it('rejects bounds that allow values the base rejected', () => {
    expect(proveMonotonicTighten(upper(10), upper(11))).toEqual({ monotonic: false, reason: 'BOUND_WEAKENED' });
    expect(proveMonotonicTighten(lower(10), lower(9))).toEqual({ monotonic: false, reason: 'BOUND_WEAKENED' });
  });

  it('accepts conjunctions only when every base clause remains', () => {
    const base: AstNode = { type: 'logic', op: 'and', args: [upper(10), lower(1)] };
    const added: AstNode = { type: 'logic', op: 'and', args: [lower(1), upper(10), lower(2)] };
    expect(proveMonotonicTighten(base, added)).toEqual({ monotonic: true, proof: 'ADDED_CONJUNCTS' });
    expect(proveMonotonicTighten(base, { type: 'logic', op: 'and', args: [upper(10)] }))
      .toEqual({ monotonic: false, reason: 'CLAUSE_REMOVED' });
  });

  it('narrows approximate tolerances and fails closed on unproved shapes', () => {
    const approx = (tolerance: string): AstNode => ({
      type: 'compare', op: 'approx', left: { type: 'fact', key: 'sum' }, right: { type: 'fact', key: 'total' }, tolerance,
    });
    expect(proveMonotonicTighten(approx('0.01'), approx('0.001')))
      .toEqual({ monotonic: true, proof: 'NARROWER_TOLERANCE' });
    expect(proveMonotonicTighten({ type: 'logic', op: 'or', args: [upper(10)] }, upper(5)))
      .toEqual({ monotonic: false, reason: 'UNSUPPORTED_SHAPE' });
  });
});
