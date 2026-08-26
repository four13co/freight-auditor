import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { GOLDEN_210, GOLDEN_310 } from '../fixtures/edi-golden.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { resolveShipmentReferenceMatch } from '../../src/modules/ingestion/shipment-reference.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';

const categorize = (code: string | undefined) => code;

describe('cross-document shipment-reference checks', () => {
  it('extracts B3-03 from a 210', () => {
    const raw = GOLDEN_210.replace('B3**INV210001*', 'B3**INV210001* SHIP-210 *');
    expect(parse210(raw, categorize).shipmentReferences).toEqual(['SHIP-210']);
  });

  it('extracts and case-insensitively deduplicates N9-02 references from a 310', () => {
    const raw = GOLDEN_310.replace('L1*', 'N9*BM*BOOK-310~N9*SI* book-310 ~N9*BN*BOL-310~L1*');
    expect(parse310(raw, categorize).shipmentReferences).toEqual(['BOOK310001', 'BOOK-310', 'BOL-310']);
  });

  it('matches normalized references inside the caller tenant transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await expect(resolveShipmentReferenceMatch(
      { query } as unknown as PoolClient,
      'client-1',
      [' SHIP-1 ', 'ship-1', 'BOL-2'],
    )).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('client_id = $1'), [
      'client-1', ['ship-1', 'bol-2'],
    ]);
  });

  it('does not query when the source states no usable reference', async () => {
    const query = vi.fn();
    await expect(resolveShipmentReferenceMatch(
      { query } as unknown as PoolClient, 'client-1', [' ', ''],
    )).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports matched, unmatched, and missing references deterministically', () => {
    const invoice = parse210(GOLDEN_210, categorize);
    const result = (shipmentReferenceMatch?: boolean) => evaluateInvoice(
      invoice, undefined, { shipmentReferenceMatch },
    ).findings.find((finding) => finding.criterionKey === 'STD.SHIPMENT_REFERENCE_MATCH')?.result;

    expect(result(true)).toBe('CONFORMED');
    expect(result(false)).toBe('VARIANCE');
    expect(result(undefined)).toBe('UNASSESSABLE');
  });
});
