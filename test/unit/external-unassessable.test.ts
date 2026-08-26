import { describe, expect, it } from 'vitest';
import type { ParsedInvoice } from '../../src/modules/ingestion/charge-fact.js';
import { buildFactBundle, externalValueFactKey } from '../../src/modules/evaluator/fact-bundle.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import type { ComposedRubric } from '../../src/modules/rubric-resolver/standard-rubric.js';

const invoice: ParsedInvoice = {
  transactionSet: 'PDF', parserVersion: 'test', headerCurrency: 'USD',
  charges: [{ code: 'LH', category: 'LINEHAUL', amount: '10.0000', currency: 'USD', quarantined: false }],
  footing: { declaredTotal: '10.0000', lineSum: '10.0000' }, quarantinedCodes: [],
};
const rubric: ComposedRubric = {
  resolverVersion: 'test',
  criteria: [{
    criterionKey: 'TEST.NMFC_VALUE_REQUIRED', kind: 'SCORING', evalOrder: 1,
    description: 'Licensed NMFC value is available.',
    ast: {
      type: 'require', key: 'external_nmfc',
      then: { type: 'compare', op: 'gt', left: { type: 'fact', key: 'external_nmfc' }, right: { type: 'lit', value: 0 } },
    },
  }],
};

describe('licensed external-data unassessable outcomes', () => {
  it('keeps unavailable values absent and preserves the stable reason', () => {
    const facts = buildFactBundle(invoice, { externalResolutions: {
      NMFC: { status: 'UNAVAILABLE', reason: 'LICENSE_REQUIRED', resolverVersion: 'nmfc-gate-v1' },
    } });
    expect(facts.external_nmfc).toBeUndefined();
    expect(facts.external_nmfc_unavailable_reason).toBe('LICENSE_REQUIRED');
    expect(facts.external_nmfc_resolver_version).toBe('nmfc-gate-v1');
  });

  it('returns UNASSESSABLE rather than passing or guessing zero', () => {
    const result = evaluateInvoice(invoice, rubric, { externalResolutions: {
      NMFC: { status: 'UNAVAILABLE', reason: 'LICENSE_REQUIRED', resolverVersion: 'nmfc-gate-v1' },
    } });
    expect(result.findings[0]?.result).toBe('UNASSESSABLE');
    expect(result.findings[0]?.evaluatedExpr.value).toMatchObject({ kind: 'unassessable' });
  });

  it('provides a deterministic numeric fact and immutable pin when available', () => {
    const result = evaluateInvoice(invoice, rubric, { externalResolutions: {
      NMFC: {
        status: 'FOUND', value: '70.000000', resolverVersion: 'nmfc-db-v1',
        pin: {
          externalValueId: 'value-1', sourceId: 'source-1', sourceCode: 'NMFC', axisKey: { item: '12345' },
          publishedFor: '2026-08-25', recordedAt: '2026-08-25T00:00:00Z',
        },
      },
    } });
    expect(result.findings[0]?.result).toBe('CONFORMED');
  });

  it('normalizes source codes into stable fact keys', () => {
    expect(externalValueFactKey(' Ocean BAF ')).toBe('external_ocean_baf');
  });
});
