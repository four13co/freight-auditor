import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { detectDuplicateInvoice } from '../../src/modules/ingestion/duplicate-invoice.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import type { ParsedInvoice } from '../../src/modules/ingestion/charge-fact.js';

const invoice: ParsedInvoice = {
  transactionSet: '210', parserVersion: 'test', invoiceNumber: ' INV-1 ', headerCurrency: 'USD',
  shipmentReferences: ['SHIP-1'], carrierCode: 'ABCD',
  charges: [{ amount: '10.0000', currency: 'USD', quarantined: false, category: 'LINEHAUL' }],
  footing: { declaredTotal: '10.0000', lineSum: '10.0000' }, quarantinedCodes: [],
};

describe('duplicate invoice detection', () => {
  it('normalizes case/whitespace and relies on the caller RLS transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });
    await expect(detectDuplicateInvoice(
      { query } as unknown as PoolClient,
      '10000000-0000-4000-8000-000000000001', ' INV-1 ', '210',
    )).resolves.toBe(true);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('pg_advisory_xact_lock'), [
      '10000000-0000-4000-8000-000000000001\u0000210\u0000inv-1',
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('lower(btrim(invoice_number))'), [
      '10000000-0000-4000-8000-000000000001', '210', 'INV-1',
    ]);
  });

  it('does not query or claim uniqueness when invoice number is absent', async () => {
    const query = vi.fn();
    await expect(detectDuplicateInvoice({ query } as unknown as PoolClient, 'client', undefined, '310')).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('produces variance for a duplicate, conformance for unique, and unassessable for missing history key', () => {
    const criterion = (duplicateInvoice?: boolean) => evaluateInvoice(invoice, undefined, { duplicateInvoice })
      .findings.find((finding) => finding.criterionKey === 'STD.DUPLICATE_INVOICE')?.result;
    expect(criterion(true)).toBe('VARIANCE');
    expect(criterion(false)).toBe('CONFORMED');
    expect(criterion(undefined)).toBe('UNASSESSABLE');
  });
});
