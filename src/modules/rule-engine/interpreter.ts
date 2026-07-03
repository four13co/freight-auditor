import { Decimal } from 'decimal.js';
import type { AstNode, FactBundle } from './ast.js';

/**
 * The owned, pure interpreter for the predicate AST (Master Spec §3.2).
 *
 * Guarantees:
 *   - PURE: no I/O, no Date.now(), no randomness — output is a function of
 *     (ast, facts) alone, so re-running is byte-identical (§5.4 determinism).
 *   - TOTAL: never throws on missing/typing data — it returns UNASSESSABLE.
 *   - DECIMAL: all money/number arithmetic goes through decimal.js, never IEEE
 *     float (§5 — 0.1 + 0.2 must be exact).
 *   - EXPLAINABLE: returns the evaluated tree, each node tagged with its value,
 *     which is the finding's explanation.
 */

export type EvalValue =
  | { kind: 'number'; value: string } // decimal string
  | { kind: 'money'; amount: string; currency: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'unassessable'; reason: string };

export interface EvalNode {
  node: AstNode;
  value: EvalValue;
  children?: EvalNode[];
}

const UNASSESSABLE = (reason: string): EvalValue => ({ kind: 'unassessable', reason });

function isUnassessable(v: EvalValue): boolean {
  return v.kind === 'unassessable';
}

/** Coerce an EvalValue to a Decimal for arithmetic, or null if not numeric. */
function toDecimal(v: EvalValue): Decimal | null {
  if (v.kind === 'number') return new Decimal(v.value);
  if (v.kind === 'money') return new Decimal(v.amount);
  return null;
}

export function evaluate(node: AstNode, facts: FactBundle): EvalNode {
  switch (node.type) {
    case 'lit': {
      const v = node.value;
      const value: EvalValue =
        typeof v === 'boolean'
          ? { kind: 'bool', value: v }
          : typeof v === 'number'
            ? { kind: 'number', value: new Decimal(v).toString() }
            : { kind: 'string', value: v };
      return { node, value };
    }
    case 'money':
      return { node, value: { kind: 'money', amount: new Decimal(node.amount).toFixed(4), currency: node.currency } };

    case 'fact': {
      const raw = facts[node.key];
      if (raw === undefined || raw === '') return { node, value: UNASSESSABLE(`fact '${node.key}' absent`) };
      let value: EvalValue;
      if (typeof raw === 'boolean') value = { kind: 'bool', value: raw };
      else if (typeof raw === 'number') value = { kind: 'number', value: new Decimal(raw).toString() };
      else if (typeof raw === 'object') value = { kind: 'money', amount: new Decimal(raw.amount).toFixed(4), currency: raw.currency };
      else value = { kind: 'string', value: raw };
      return { node, value };
    }

    case 'require': {
      const present = facts[node.key];
      if (present === undefined || present === '') {
        return { node, value: UNASSESSABLE(`required fact '${node.key}' absent`) };
      }
      const child = evaluate(node.then, facts);
      return { node, value: child.value, children: [child] };
    }

    case 'arith': {
      const children = node.args.map((a) => evaluate(a, facts));
      const un = children.find((c) => isUnassessable(c.value));
      if (un) return { node, value: UNASSESSABLE('operand unassessable'), children };
      const decs = children.map((c) => toDecimal(c.value));
      if (decs.some((d) => d === null)) return { node, value: UNASSESSABLE('non-numeric operand'), children };
      const nums = decs as Decimal[];
      let result: Decimal;
      switch (node.op) {
        case 'add': result = nums.reduce((a, b) => a.plus(b), new Decimal(0)); break;
        case 'sub': result = nums.slice(1).reduce((a, b) => a.minus(b), nums[0] ?? new Decimal(0)); break;
        case 'mul': result = nums.reduce((a, b) => a.times(b), new Decimal(1)); break;
        case 'div':
          if (nums.slice(1).some((d) => d.isZero())) return { node, value: UNASSESSABLE('division by zero'), children };
          result = nums.slice(1).reduce((a, b) => a.dividedBy(b), nums[0] ?? new Decimal(0));
          break;
        case 'abs': result = (nums[0] ?? new Decimal(0)).abs(); break;
      }
      return { node, value: { kind: 'number', value: result.toString() }, children };
    }

    case 'compare': {
      const left = evaluate(node.left, facts);
      const right = evaluate(node.right, facts);
      const children = [left, right];
      if (isUnassessable(left.value) || isUnassessable(right.value)) {
        return { node, value: UNASSESSABLE('comparand unassessable'), children };
      }
      const a = toDecimal(left.value);
      const b = toDecimal(right.value);
      // String/bool equality path.
      if (a === null || b === null) {
        const ls = valueScalar(left.value);
        const rs = valueScalar(right.value);
        const eq = ls === rs;
        if (node.op === 'eq') return { node, value: { kind: 'bool', value: eq }, children };
        if (node.op === 'ne') return { node, value: { kind: 'bool', value: !eq }, children };
        return { node, value: UNASSESSABLE('non-numeric comparison'), children };
      }
      let result: boolean;
      switch (node.op) {
        case 'eq': result = a.equals(b); break;
        case 'ne': result = !a.equals(b); break;
        case 'gt': result = a.greaterThan(b); break;
        case 'gte': result = a.greaterThanOrEqualTo(b); break;
        case 'lt': result = a.lessThan(b); break;
        case 'lte': result = a.lessThanOrEqualTo(b); break;
        case 'approx': {
          const tol = new Decimal(node.tolerance ?? '0');
          result = a.minus(b).abs().lessThanOrEqualTo(tol);
          break;
        }
      }
      return { node, value: { kind: 'bool', value: result }, children };
    }

    case 'logic': {
      const children = node.args.map((a) => evaluate(a, facts));
      if (node.op === 'not') {
        const c = children[0];
        if (!c || c.value.kind !== 'bool') return { node, value: UNASSESSABLE('not: non-bool'), children };
        return { node, value: { kind: 'bool', value: !c.value.value }, children };
      }
      const bools = children.map((c) => (c.value.kind === 'bool' ? c.value.value : null));
      if (bools.some((b) => b === null)) return { node, value: UNASSESSABLE(`${node.op}: non-bool operand`), children };
      const result = node.op === 'and' ? bools.every(Boolean) : bools.some(Boolean);
      return { node, value: { kind: 'bool', value: result }, children };
    }
  }
}

function valueScalar(v: EvalValue): string | boolean | null {
  if (v.kind === 'string') return v.value;
  if (v.kind === 'bool') return v.value;
  if (v.kind === 'number') return v.value;
  if (v.kind === 'money') return v.amount;
  return null;
}

/** A rule's top-level verdict: pass/fail from a boolean, or unassessable. */
export function verdict(ev: EvalNode): 'PASS' | 'FAIL' | 'UNASSESSABLE' {
  if (ev.value.kind === 'bool') return ev.value.value ? 'PASS' : 'FAIL';
  return 'UNASSESSABLE';
}
