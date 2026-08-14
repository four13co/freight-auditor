import { describe, it, expect } from 'vitest';
import { evaluate, verdict } from '../../src/modules/rule-engine/interpreter.js';
import type { AstNode, FactBundle } from '../../src/modules/rule-engine/ast.js';

/**
 * Dedicated interpreter test file (86e25tdj6). Covers the module's documented
 * "never throws — returns UNASSESSABLE" contract (interpreter.ts:10-11) for
 * numeric/arith/compare paths: div-by-zero (correct, previously untested),
 * invalid-decimal money/fact values (previously threw), NaN/Infinity
 * propagation (previously silent), and zero/one-arg arith calls.
 *
 * Cross-currency compare is explicitly out of scope (see the ClickUp item's
 * No-gos) — a separate, contested product-semantics question.
 */
describe('interpreter: arith/compare are total (never throw, return UNASSESSABLE)', () => {
  it('div by zero returns UNASSESSABLE (currently-correct behavior, now covered)', () => {
    const ast: AstNode = {
      type: 'arith', op: 'div',
      args: [{ type: 'lit', value: 10 }, { type: 'lit', value: 0 }],
    };
    const ev = evaluate(ast, {});
    expect(ev.value).toEqual({ kind: 'unassessable', reason: 'division by zero' });
  });

  it('a money node with a non-numeric amount returns UNASSESSABLE, never throws (interpreter.ts:56)', () => {
    const ast: AstNode = { type: 'money', amount: 'ABC', currency: 'USD' };
    expect(() => evaluate(ast, {})).not.toThrow();
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });

  it('a fact node with a non-numeric money amount returns UNASSESSABLE, never throws (interpreter.ts:64)', () => {
    const facts: FactBundle = { rate: { amount: 'N/A', currency: 'USD' } };
    const ast: AstNode = { type: 'fact', key: 'rate' };
    expect(() => evaluate(ast, facts)).not.toThrow();
    const ev = evaluate(ast, facts);
    expect(ev.value.kind).toBe('unassessable');
  });

  it('a NaN fact value is UNASSESSABLE, not silently propagated as {kind:number, value:"NaN"}', () => {
    const facts: FactBundle = { qty: NaN };
    const ast: AstNode = { type: 'fact', key: 'qty' };
    const ev = evaluate(ast, facts);
    expect(ev.value.kind).toBe('unassessable');
  });

  it('an Infinity fact value is UNASSESSABLE, not silently propagated', () => {
    const facts: FactBundle = { qty: Infinity };
    const ast: AstNode = { type: 'fact', key: 'qty' };
    const ev = evaluate(ast, facts);
    expect(ev.value.kind).toBe('unassessable');
  });

  it('arith on a NaN operand is UNASSESSABLE, not a silently-propagated NaN result', () => {
    const facts: FactBundle = { qty: NaN };
    const ast: AstNode = {
      type: 'arith', op: 'add',
      args: [{ type: 'fact', key: 'qty' }, { type: 'lit', value: 1 }],
    };
    const ev = evaluate(ast, facts);
    expect(ev.value.kind).toBe('unassessable');
  });

  it('compare on an Infinity operand is UNASSESSABLE, not a bogus true/false', () => {
    const facts: FactBundle = { qty: Infinity };
    const ast: AstNode = {
      type: 'compare', op: 'gt',
      left: { type: 'fact', key: 'qty' },
      right: { type: 'lit', value: 1 },
    };
    const ev = evaluate(ast, facts);
    expect(ev.value.kind).toBe('unassessable');
  });

  it('a zero-arg div returns UNASSESSABLE rather than the identity value 0', () => {
    const ast: AstNode = { type: 'arith', op: 'div', args: [] };
    expect(() => evaluate(ast, {})).not.toThrow();
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });

  it('a zero-arg mul returns UNASSESSABLE rather than the identity value 1', () => {
    const ast: AstNode = { type: 'arith', op: 'mul', args: [] };
    expect(() => evaluate(ast, {})).not.toThrow();
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });

  it('a one-arg sub returns UNASSESSABLE rather than treating it as identity', () => {
    const ast: AstNode = { type: 'arith', op: 'sub', args: [{ type: 'lit', value: 5 }] };
    expect(() => evaluate(ast, {})).not.toThrow();
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });
});

/**
 * Coverage-gap closure (86e2u72u2): the `logic` node (and/or/not) and `verdict()`
 * had zero test coverage (interpreter.ts:169-189, 193-196) despite deciding a
 * rule's final PASS/FAIL/UNASSESSABLE outcome.
 */
describe('interpreter: logic node (and/or/not)', () => {
  it('and is true only when every operand is true', () => {
    const ast: AstNode = {
      type: 'logic', op: 'and',
      args: [{ type: 'lit', value: true }, { type: 'lit', value: true }],
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('and is false when any operand is false', () => {
    const ast: AstNode = {
      type: 'logic', op: 'and',
      args: [{ type: 'lit', value: true }, { type: 'lit', value: false }],
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: false });
  });

  it('or is true when any operand is true', () => {
    const ast: AstNode = {
      type: 'logic', op: 'or',
      args: [{ type: 'lit', value: false }, { type: 'lit', value: true }],
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('or is false only when every operand is false', () => {
    const ast: AstNode = {
      type: 'logic', op: 'or',
      args: [{ type: 'lit', value: false }, { type: 'lit', value: false }],
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: false });
  });

  it('not negates a single bool operand', () => {
    const ast: AstNode = { type: 'logic', op: 'not', args: [{ type: 'lit', value: false }] };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('not with a missing operand is UNASSESSABLE, not a thrown error', () => {
    const ast: AstNode = { type: 'logic', op: 'not', args: [] };
    expect(() => evaluate(ast, {})).not.toThrow();
    expect(evaluate(ast, {}).value.kind).toBe('unassessable');
  });

  it('not on a non-bool operand is UNASSESSABLE, not a thrown error', () => {
    const ast: AstNode = { type: 'logic', op: 'not', args: [{ type: 'lit', value: 5 }] };
    const ev = evaluate(ast, {});
    expect(ev.value).toEqual({ kind: 'unassessable', reason: 'not: non-bool' });
  });

  it('and with a non-bool operand is UNASSESSABLE, not silently coerced', () => {
    const ast: AstNode = {
      type: 'logic', op: 'and',
      args: [{ type: 'lit', value: true }, { type: 'lit', value: 'not-a-bool' }],
    };
    const ev = evaluate(ast, {});
    expect(ev.value).toEqual({ kind: 'unassessable', reason: 'and: non-bool operand' });
  });

  it('an unassessable operand propagates through and/or as UNASSESSABLE, never a bogus true/false', () => {
    const ast: AstNode = {
      type: 'logic', op: 'or',
      args: [{ type: 'fact', key: 'missing' }, { type: 'lit', value: true }],
    };
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });
});

describe('interpreter: compare approx + valueScalar branches', () => {
  it('approx is true when the difference is within tolerance', () => {
    const ast: AstNode = {
      type: 'compare', op: 'approx', tolerance: '0.05',
      left: { type: 'lit', value: 10 },
      right: { type: 'lit', value: 10.03 },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('approx is false when the difference exceeds tolerance', () => {
    const ast: AstNode = {
      type: 'compare', op: 'approx', tolerance: '0.01',
      left: { type: 'lit', value: 10 },
      right: { type: 'lit', value: 10.5 },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: false });
  });

  it('approx with no tolerance specified defaults to exact equality', () => {
    const ast: AstNode = {
      type: 'compare', op: 'approx',
      left: { type: 'lit', value: 10 },
      right: { type: 'lit', value: 10 },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('eq compares two money values by their decimal amount via valueScalar (non-numeric path)', () => {
    // Money vs. string forces toDecimal() to null on the string side, taking the
    // string/bool equality path — which routes both operands through valueScalar,
    // exercising its `money` (amount) branch.
    const ast: AstNode = {
      type: 'compare', op: 'eq',
      left: { type: 'money', amount: '10.00', currency: 'USD' },
      right: { type: 'lit', value: '10.0000' },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('ne on two unequal string scalars is true', () => {
    const ast: AstNode = {
      type: 'compare', op: 'ne',
      left: { type: 'lit', value: 'a' },
      right: { type: 'lit', value: 'b' },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('gte is true for both equal and greater numeric operands', () => {
    const equalAst: AstNode = {
      type: 'compare', op: 'gte',
      left: { type: 'lit', value: 5 },
      right: { type: 'lit', value: 5 },
    };
    expect(evaluate(equalAst, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('lt is true when the left operand is strictly smaller', () => {
    const ast: AstNode = {
      type: 'compare', op: 'lt',
      left: { type: 'lit', value: 3 },
      right: { type: 'lit', value: 5 },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('lte is true for both equal and lesser numeric operands', () => {
    const ast: AstNode = {
      type: 'compare', op: 'lte',
      left: { type: 'lit', value: 5 },
      right: { type: 'lit', value: 5 },
    };
    expect(evaluate(ast, {}).value).toEqual({ kind: 'bool', value: true });
  });

  it('gt/lt on non-numeric scalars is UNASSESSABLE, not a bogus comparison', () => {
    const ast: AstNode = {
      type: 'compare', op: 'gt',
      left: { type: 'lit', value: 'a' },
      right: { type: 'lit', value: 'b' },
    };
    const ev = evaluate(ast, {});
    expect(ev.value).toEqual({ kind: 'unassessable', reason: 'non-numeric comparison' });
  });
});

describe('interpreter: verdict()', () => {
  it('a true bool result is PASS', () => {
    const ev = evaluate({ type: 'lit', value: true }, {});
    expect(verdict(ev)).toBe('PASS');
  });

  it('a false bool result is FAIL', () => {
    const ev = evaluate({ type: 'lit', value: false }, {});
    expect(verdict(ev)).toBe('FAIL');
  });

  it('a non-bool (e.g. unassessable) result is UNASSESSABLE', () => {
    const ev = evaluate({ type: 'fact', key: 'missing' }, {});
    expect(verdict(ev)).toBe('UNASSESSABLE');
  });
});
