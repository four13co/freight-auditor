import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { detectDuplicateClaimedFinding, DuplicateClaimedFindingError } from '../../src/modules/claims/detect-duplicate-claimed-finding.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const DISPUTE_ID = '10000000-0000-4000-8000-000000000002';

function mockClient(rows: { variance_finding_id: string }[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('detectDuplicateClaimedFinding (unit, mocked client)', () => {
  it('resolves without error when no conflicting claimed finding exists', async () => {
    const { client } = mockClient([]);
    await expect(detectDuplicateClaimedFinding(client, CLIENT_ID, DISPUTE_ID)).resolves.toBeUndefined();
  });

  it('throws DuplicateClaimedFindingError naming every conflicting finding when one exists', async () => {
    const { client } = mockClient([
      { variance_finding_id: 'finding-1' },
      { variance_finding_id: 'finding-2' },
    ]);
    try {
      await detectDuplicateClaimedFinding(client, CLIENT_ID, DISPUTE_ID);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateClaimedFindingError);
      expect((err as DuplicateClaimedFindingError).conflictingFindingIds).toEqual(['finding-1', 'finding-2']);
    }
  });

  it('scopes the query to the caller tenant and the target dispute', async () => {
    const { client, query } = mockClient([]);
    await detectDuplicateClaimedFinding(client, CLIENT_ID, DISPUTE_ID);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([CLIENT_ID, DISPUTE_ID]);
  });
});
