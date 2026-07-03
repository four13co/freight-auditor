import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluate } from '../../src/modules/rule-engine/interpreter.js';
import type { AstNode } from '../../src/modules/rule-engine/ast.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import {
  GOLDEN_210, GOLDEN_210_EXPECTED,
  GOLDEN_310, GOLDEN_310_EXPECTED,
  MALFORMED_210_NOFOOT, MALFORMED_310_NOCURRENCY,
  testCategorize,
} from '../fixtures/edi-golden.js';

/**
 * Phase 1 deterministic engine contract (ClickUp 86e24cy5r). Pure — no DB. Maps
 * each acceptance criterion to assertions on parser + interpreter + evaluator.
 */
describe('Phase 1 engine (pure)', () => {
  // AC1 — golden 210/310 parse to hand-checked charge facts.
  it('AC1: golden 210 parses to expected charge facts + footing', () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    expect(inv.invoiceNumber).toBe(GOLDEN_210_EXPECTED.invoiceNumber);
    expect(inv.footing?.declaredTotal).toBe(GOLDEN_210_EXPECTED.declaredTotal);
    expect(inv.footing?.lineSum).toBe(GOLDEN_210_EXPECTED.lineSum);
    expect(inv.charges.map((c) => ({ code: c.code, amount: c.amount, currency: c.currency, category: c.category })))
      .toEqual(GOLDEN_210_EXPECTED.charges);
    expect(inv.quarantinedCodes).toEqual([]);
  });

  it('AC1: golden 310 parses with PER-CHARGE currency (never defaulted USD)', () => {
    const inv = parse310(GOLDEN_310, testCategorize);
    expect(inv.invoiceNumber).toBe(GOLDEN_310_EXPECTED.invoiceNumber);
    expect(inv.footing?.declaredTotal).toBe(GOLDEN_310_EXPECTED.declaredTotal);
    expect(inv.charges.map((c) => ({ code: c.code, amount: c.amount, currency: c.currency, category: c.category })))
      .toEqual(GOLDEN_310_EXPECTED.charges);
    // The EUR charge is genuinely EUR, not silently USD.
    expect(inv.charges.find((c) => c.code === '510')?.currency).toBe('EUR');
  });

  // AC2 — malformed invoice → REJECTED_REWORK with ALL failed gates (COLLECT_ALL).
  it('AC2: 210 that does not foot → REJECTED_REWORK, footing in the kickback', () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const r = evaluateInvoice(inv);
    expect(r.outcome).toBe('REJECTED_REWORK');
    expect(r.gateFailures.map((g) => g.criterionKey)).toContain('STD.FOOTING');
    // Each failure carries a citation for the carrier.
    expect(r.gateFailures.find((g) => g.criterionKey === 'STD.FOOTING')?.citation).toBeTruthy();
  });

  it('AC2: 310 with unstated currency → REJECTED_REWORK on currency gate', () => {
    const inv = parse310(MALFORMED_310_NOCURRENCY, testCategorize);
    const r = evaluateInvoice(inv);
    expect(r.outcome).toBe('REJECTED_REWORK');
    expect(r.gateFailures.map((g) => g.criterionKey)).toContain('STD.CURRENCY_STATED');
  });

  it('AC2: COLLECT_ALL — an invoice failing two gates lists BOTH, not just the first', () => {
    // Empty invoice: no charges (HAS_CHARGES fails) AND currency vacuously stated
    // but footing is unassessable (no declared_total → require blocks). Craft one
    // that trips footing + has-charges together via a no-line, declared-total invoice.
    const inv = parse210(
      'ISA*00*          *00*          *ZZ*S              *ZZ*R              *260703*1200*U*00401*000000009*0*P*>~' +
      'GS*IM*S*R*20260703*1200*9*X*004010~ST*210*0009~B3**INVX*****100.00***USD~SE*3*0009~',
      testCategorize,
    );
    const r = evaluateInvoice(inv);
    expect(r.outcome).toBe('REJECTED_REWORK');
    const keys = r.gateFailures.map((g) => g.criterionKey);
    // No charges → HAS_CHARGES fails; declared 100 vs line-sum 0 → FOOTING fails. Both present.
    expect(keys).toContain('STD.HAS_CHARGES');
    expect(keys).toContain('STD.FOOTING');
    expect(r.gateFailures.length).toBeGreaterThanOrEqual(2);
  });

  // AC3 — valid invoice → SCORED with a per-criterion scorecard.
  it('AC3: valid 210 → SCORED with a scorecard', () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const r = evaluateInvoice(inv);
    expect(r.outcome).toBe('SCORED');
    expect(r.scorecard).not.toBeNull();
    expect(r.findings.length).toBeGreaterThan(0);
    const total = r.scorecard!.conformedCount + r.scorecard!.varianceCount + r.scorecard!.unassessableCount;
    expect(total).toBe(r.findings.length);
    // Golden 210 has a FUEL charge + no quarantined codes → both scoring criteria conform.
    expect(r.scorecard!.conformedCount).toBe(2);
  });

  // AC4 — same invoice + same rubric → byte-identical findings (determinism §5.4).
  it('AC4: re-running the same invoice is byte-identical', () => {
    const inv = parse310(GOLDEN_310, testCategorize);
    const a = evaluateInvoice(inv);
    const b = evaluateInvoice(parse310(GOLDEN_310, testCategorize));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The rubric hash is stable across runs (the pin that guarantees replay).
    expect(a.pins.rubricContentHash).toBe(b.pins.rubricContentHash);
  });

  // AC5 — decimal-edge money has no IEEE float drift.
  it('AC5: interpreter arithmetic has no float drift (0.1 + 0.2 = 0.3 exactly)', () => {
    const ast: AstNode = {
      type: 'arith', op: 'add',
      args: [{ type: 'lit', value: 0.1 }, { type: 'lit', value: 0.2 }],
    };
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('number');
    if (ev.value.kind === 'number') {
      expect(new Decimal(ev.value.value).equals(new Decimal('0.3'))).toBe(true);
      // The naive float path would give 0.30000000000000004.
      expect(ev.value.value).not.toContain('30000000000000');
    }
  });

  it('AC5: footing approx-compare respects the tolerance boundary', () => {
    // 100.00 vs 100.005 with tolerance 0.01 → within → PASS.
    const within: AstNode = {
      type: 'compare', op: 'approx', tolerance: '0.01',
      left: { type: 'money', amount: '100.00', currency: 'USD' },
      right: { type: 'money', amount: '100.005', currency: 'USD' },
    };
    expect(evaluate(within, {}).value).toMatchObject({ kind: 'bool', value: true });
    // 100.00 vs 100.02 → outside → FAIL.
    const outside: AstNode = {
      type: 'compare', op: 'approx', tolerance: '0.01',
      left: { type: 'money', amount: '100.00', currency: 'USD' },
      right: { type: 'money', amount: '100.02', currency: 'USD' },
    };
    expect(evaluate(outside, {}).value).toMatchObject({ kind: 'bool', value: false });
  });

  // AC6 — a HARD gate failure means the SCORE phase does NOT run.
  it('AC6: HARD gate failure skips scoring (no findings on a rejected run)', () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const r = evaluateInvoice(inv);
    expect(r.outcome).toBe('REJECTED_REWORK');
    expect(r.findings).toEqual([]); // SCORE phase never ran
    expect(r.scorecard).toBeNull();
  });

  it('interpreter is total — a missing required fact yields UNASSESSABLE, never a throw', () => {
    const ast: AstNode = { type: 'require', key: 'absent', then: { type: 'lit', value: true } };
    const ev = evaluate(ast, {});
    expect(ev.value.kind).toBe('unassessable');
  });
});
