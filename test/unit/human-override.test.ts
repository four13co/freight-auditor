import { describe, expect, it, vi } from 'vitest';
import { applyHumanOverride, HUMAN_OVERRIDE_RESOLVER_VERSION, resolveHumanOverride } from '../../src/modules/rubric-resolver/human-override.js';

const request = {
  clientId: '11111111-1111-4111-8111-111111111111',
  criterionId: '21111111-1111-4111-8111-111111111111',
  caseFingerprint: 'mode=ROAD|charge=FUEL', recordedAsOf: '2026-08-25T12:00:00.000Z',
};

describe('human overrides applied last', () => {
  it('prefers exact tenant scope before knowledge-time recency', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '31111111-1111-4111-8111-111111111111', asserted_value: { exempt: true },
      recorded_at: new Date('2026-08-01T00:00:00Z'),
    }] });
    const resolved = await resolveHumanOverride({ query } as never, request);
    expect(resolved).toMatchObject({ status: 'FOUND', assertedValue: { exempt: true }, resolverVersion: HUMAN_OVERRIDE_RESOLVER_VERSION });
    expect(query.mock.calls[0]![0]).toContain('ORDER BY (client_id = $1) DESC');
    expect(applyHumanOverride({ exempt: false }, resolved)).toEqual({
      value: { exempt: true }, humanOverrideId: '31111111-1111-4111-8111-111111111111',
    });
  });

  it('leaves cascade output unchanged when no override matches', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const resolved = await resolveHumanOverride({ query } as never, request);
    expect(applyHumanOverride('cascade', resolved)).toEqual({ value: 'cascade', humanOverrideId: null });
  });

  it('fails closed on incomplete fingerprints before querying', async () => {
    const query = vi.fn();
    await expect(resolveHumanOverride({ query } as never, { ...request, caseFingerprint: ' ' }))
      .rejects.toMatchObject({ code: 'HUMAN_OVERRIDE_REQUEST_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
