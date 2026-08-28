import { describe, expect, it, vi } from 'vitest';
import {
  detectDuplicateFindingInclusion,
  DuplicateFindingInclusionError,
} from '../../src/modules/disputes/detect-duplicate-finding-inclusion.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const findingAId = '21111111-1111-4111-8111-111111111111';
const findingBId = '31111111-1111-4111-8111-111111111111';

describe('detectDuplicateFindingInclusion', () => {
  it('does nothing when no candidate finding already appears on a dispute_line', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(detectDuplicateFindingInclusion(client(query), clientId, [findingAId, findingBId]))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws naming every conflicting finding id when one or more already appear on a dispute_line', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ variance_finding_id: findingAId }] });
    const error = await detectDuplicateFindingInclusion(client(query), clientId, [findingAId, findingBId])
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateFindingInclusionError);
    expect((error as DuplicateFindingInclusionError).conflictingFindingIds).toEqual([findingAId]);
  });

  it('skips the query entirely for an empty candidate list', async () => {
    const query = vi.fn();
    await expect(detectDuplicateFindingInclusion(client(query), clientId, [])).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});

function client(query: ReturnType<typeof vi.fn>) {
  return { query } as never;
}
