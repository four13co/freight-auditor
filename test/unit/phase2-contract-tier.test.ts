import { describe, it, expect } from 'vitest';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { CONTRACT_RUBRIC } from '../../src/modules/rubric-resolver/contract-rubric.js';
import { STANDARD_RUBRIC } from '../../src/modules/rubric-resolver/standard-rubric.js';
import { GOLDEN_210, MALFORMED_210_NOFOOT, testCategorize } from '../fixtures/edi-golden.js';

/**
 * Phase 2 CONTRACT-tier rubric contract (ClickUp 86e25te91). Pure — no DB (the
 * DB-backed rate lookup is exercised separately in the .db test suite).
 *
 * GOLDEN_210's billed LINEHAUL charge is exactly $1000.00 (code 400) — used as
 * the "bills exactly the contracted rate" case; a $1100.00 rate exercises the
 * 10%-over VARIANCE case from the other direction (billed < contracted would
 * be an undercharge finding, not what AC2 asks for, so the contracted rate is
 * set BELOW the billed amount here to produce an overcharge, matching AC2's
 * "invoice bills 10% over" framing).
 */
describe('Phase 2 CONTRACT-tier rubric (pure)', () => {
  // AC1 — billed exactly matches the contracted rate → CONFORMED.
  it('AC1: billed linehaul == contracted rate → CONTRACT.RATE_VARIANCE is CONFORMED', () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const r = evaluateInvoice(inv, CONTRACT_RUBRIC, {
      linehaulRate: { amount: '1000.0000', currency: 'USD', clauseId: null },
    });
    expect(r.outcome).toBe('SCORED');
    const finding = r.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('CONFORMED');
  });

  // AC2 — billed 10% over the contracted rate → VARIANCE with the $ delta recorded.
  it('AC2: billed linehaul 10% over contracted rate → VARIANCE with dollar delta in the scorecard', () => {
    const inv = parse210(GOLDEN_210, testCategorize); // billed LINEHAUL = 1000.00
    // Contracted rate 909.0909 -> billed is ~10% over (900 would be exact 10%;
    // use a round contracted rate of 900.00 for a clean, hand-checkable delta).
    const r = evaluateInvoice(inv, CONTRACT_RUBRIC, {
      linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null },
    });
    expect(r.outcome).toBe('SCORED');
    const finding = r.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('VARIANCE');
    // billed 1000.00 - contracted 900.00 = 100.00 overcharge.
    expect(r.scorecard!.totalOvercharge).toBe('100.0000');
    expect(r.scorecard!.totalUndercharge).toBe('0.0000');
  });

  // AC3 — no contract rate for the invoice's charge category → UNASSESSABLE, never guessed.
  it('AC3: no contract rate found → CONTRACT.RATE_VARIANCE is UNASSESSABLE (never defaulted)', () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const r = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: null });
    expect(r.outcome).toBe('SCORED');
    const finding = r.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('UNASSESSABLE');
    // An unassessable criterion contributes nothing to the $ rollup — never a guess.
    expect(r.scorecard!.totalOvercharge).toBe('0.0000');
    expect(r.scorecard!.totalUndercharge).toBe('0.0000');
  });

  // AC4 — CONTRACT cascades STANDARD's GATING criteria unchanged; a STANDARD-only
  // run is unaffected (existing phase1-engine.test.ts fixtures untouched by this PR).
  it('AC4: CONTRACT rubric cascades STANDARD gating unchanged — malformed invoice still REJECTED_REWORK', () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const r = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '1000.0000', currency: 'USD', clauseId: null } });
    expect(r.outcome).toBe('REJECTED_REWORK');
    expect(r.gateFailures.map((g) => g.criterionKey)).toContain('STD.FOOTING');
  });

  it('AC4: a STANDARD-only run (no contract facts) is unaffected — no CONTRACT.RATE_VARIANCE finding', () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const r = evaluateInvoice(inv, STANDARD_RUBRIC); // no third argument — pre-existing call shape
    expect(r.outcome).toBe('SCORED');
    expect(r.findings.map((f) => f.criterionKey)).not.toContain('CONTRACT.RATE_VARIANCE');
  });

  it('CONTRACT_RUBRIC includes all of STANDARD_RUBRIC\'s GATING criteria plus the one new SCORING criterion', () => {
    const standardGating = STANDARD_RUBRIC.criteria.filter((c) => c.kind === 'GATING').map((c) => c.criterionKey);
    const contractGating = CONTRACT_RUBRIC.criteria.filter((c) => c.kind === 'GATING').map((c) => c.criterionKey);
    expect(contractGating.sort()).toEqual(standardGating.sort());
    const contractScoring = CONTRACT_RUBRIC.criteria.filter((c) => c.kind === 'SCORING').map((c) => c.criterionKey);
    expect(contractScoring).toContain('CONTRACT.RATE_VARIANCE');
    expect(contractScoring).toContain('STD.NO_QUARANTINED_CODES');
    expect(contractScoring).toContain('STD.FUEL_PRESENT');
  });
});
