import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/modules/rule-engine/interpreter.js';
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
