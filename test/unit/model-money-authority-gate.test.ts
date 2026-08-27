import { describe, expect, it } from 'vitest';
import { rejectModelMoneyAuthority, validateNoModelMoneyAuthority } from '../../src/modules/contracts/model-money-authority-gate.js';

describe('model money authority gate', () => {
  it('accepts descriptive and citation text containing money language without treating text as authority', () => {
    expect(validateNoModelMoneyAuthority({ description: 'Compare billed and contracted values.',
      citations: [{ excerpt: 'The rate is $10.00 per hundredweight.' }], sourceValue: '10.00 USD' }))
      .toEqual({ accepted: true, rejections: [] });
  });

  it('rejects arithmetic AST and money literal nodes at deterministic paths', () => {
    expect(validateNoModelMoneyAuthority({ criteria: [{ ast: { type: 'arith', op: 'mul', args: [
      { type: 'money', amount: '10.00', currency: 'USD' }, { type: 'lit', value: 2 },
    ] } }] })).toEqual({ accepted: false, rejections: [
      { code: 'ARITHMETIC_AST', path: '$.criteria[0].ast' },
      { code: 'MONEY_LITERAL', path: '$.criteria[0].ast.args[0]' },
    ] });
  });

  it('rejects authoritative financial fields regardless of casing or separators', () => {
    const result = validateNoModelMoneyAuthority({ variance_amount: '2.00', nested: { ExpectedCharge: { amount: '12.00' },
      invoicePayableAmount: '10.00' } });
    expect(result.rejections).toEqual([
      { code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: '$.nested.ExpectedCharge' },
      { code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: '$.nested.ExpectedCharge.amount' },
      { code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: '$.nested.invoicePayableAmount' },
      { code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: '$.variance_amount' },
    ]);
  });

  it('is deterministic across retries and throws one stable fail-closed error', () => {
    const unsafe = { total: '12.00', ast: { type: 'arith' } };
    expect(validateNoModelMoneyAuthority(unsafe)).toEqual(validateNoModelMoneyAuthority(unsafe));
    expect(() => rejectModelMoneyAuthority(unsafe)).toThrow(expect.objectContaining({
      code: 'MODEL_MONEY_AUTHORITY_REJECTED', rejections: [
        { code: 'ARITHMETIC_AST', path: '$.ast' },
        { code: 'AUTHORITATIVE_FINANCIAL_FIELD', path: '$.total' },
      ],
    }));
  });
});
