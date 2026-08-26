import { describe, expect, it, vi } from 'vitest';
import {
  RUBRIC_VERSION_SELECTOR_VERSION,
  selectRubricVersion,
} from '../../src/modules/rubric-resolver/select-rubric-version.js';

const request = {
  rubricId: '11111111-1111-4111-8111-111111111111',
  effectiveOn: '2026-07-01',
  recordedAsOf: '2026-08-25T12:00:00.000Z',
};

describe('bitemporal rubric-version selection', () => {
  it('binds both business time and system time and returns a version pin', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '22222222-2222-4222-8222-222222222222', rubric_id: request.rubricId,
      valid_from: '2026-01-01', valid_to: null, recorded_at: new Date('2026-06-01T00:00:00Z'),
    }] });
    await expect(selectRubricVersion({ query } as never, request)).resolves.toEqual({
      status: 'FOUND', version: {
        id: '22222222-2222-4222-8222-222222222222', rubricId: request.rubricId,
        validFrom: '2026-01-01', validTo: null, recordedAt: '2026-06-01T00:00:00.000Z',
        selectorVersion: RUBRIC_VERSION_SELECTOR_VERSION,
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('recorded_at <= $3::timestamptz'), [
      request.rubricId, request.effectiveOn, request.recordedAsOf,
    ]);
    expect(query.mock.calls[0]![0]).toContain('valid_to > $2::date');
  });

  it('returns explicit unavailability when nothing was known at the cutoff', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(selectRubricVersion({ query } as never, request)).resolves.toEqual({
      status: 'UNAVAILABLE', reason: 'NO_VERSION_KNOWN',
    });
  });

  it('rejects malformed dates and identifiers before querying', async () => {
    const query = vi.fn();
    await expect(selectRubricVersion({ query } as never, { ...request, effectiveOn: 'today' }))
      .rejects.toMatchObject({ code: 'RUBRIC_VERSION_SELECTION_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
