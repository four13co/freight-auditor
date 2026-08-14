import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getFindingsSummary } from '../../src/modules/findings/findings-summary.js';

/**
 * Unit-level coverage of getFindingsSummary's query shape and row mapping via
 * a mocked pg client -- no live DB. test/db/findings-summary.db.test.ts covers
 * the same function against real Postgres (RLS isolation, the actual status
 * filters, the 30-day window) and stays the source of truth for that
 * behavior; this file exists so the default coverage gate (test/db/**
 * excluded) also exercises this module -- same reasoning as
 * list-findings.test.ts (86e2u7j0d Review finding: this module previously
 * dropped into default-suite scope via app.ts's import chain at 0% covered).
 */
function mockClient(row: Record<string, string>) {
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getFindingsSummary (unit, mocked client)', () => {
  it('maps snake_case aggregate columns to the FindingsSummary shape', async () => {
    const { client } = mockClient({
      recoverable_open: '150.0000',
      flagged_today: '3',
      with_carriers: '2',
      recovered_last_30_days: '75.0000',
    });
    const summary = await getFindingsSummary(client);
    expect(summary).toEqual({
      recoverableOpen: '150.0000',
      flaggedToday: 3,
      withCarriers: 2,
      recoveredLast30Days: '75.0000',
    });
  });

  it('runs a single query with no parameters', async () => {
    const { client, query } = mockClient({
      recoverable_open: '0',
      flagged_today: '0',
      with_carriers: '0',
      recovered_last_30_days: '0',
    });
    await getFindingsSummary(client);
    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([]);
  });

  it('defaults every field to zero when the query returns no row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as pg.PoolClient;
    const summary = await getFindingsSummary(client);
    expect(summary).toEqual({
      recoverableOpen: '0',
      flaggedToday: 0,
      withCarriers: 0,
      recoveredLast30Days: '0',
    });
  });
});
