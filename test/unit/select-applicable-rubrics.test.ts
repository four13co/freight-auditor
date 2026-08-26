import { describe, expect, it, vi } from 'vitest';
import { selectApplicableRubricVersions } from '../../src/modules/rubric-resolver/select-applicable-rubrics.js';

const request = {
  clientId: '11111111-1111-4111-8111-111111111111',
  contractId: '22222222-2222-4222-8222-222222222222',
  mode: 'ROAD' as const,
  effectiveOn: '2026-08-01',
  recordedAsOf: '2026-08-25T12:00:00.000Z',
};

describe('rubric mode and effective-date filtering', () => {
  it('binds tenant, contract, mode, business date, and knowledge cutoff', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      rubric_id: 'r1', rubric_version_id: 'v1', tier: 'CLIENT', valid_from: '2026-01-01',
      valid_to: null, recorded_at: new Date('2026-02-01T00:00:00Z'),
    }] });
    await expect(selectApplicableRubricVersions({ query } as never, request)).resolves.toEqual([{
      rubricId: 'r1', rubricVersionId: 'v1', tier: 'CLIENT', validFrom: '2026-01-01',
      validTo: null, recordedAt: '2026-02-01T00:00:00.000Z',
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('$3::transport_mode = ANY(r.mode_filter)'), [
      request.clientId, request.contractId, request.mode, request.effectiveOn, request.recordedAsOf,
    ]);
    expect(query.mock.calls[0]![0]).toContain('valid_to > $4::date');
  });

  it('excludes contract scope when no contract is supplied', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await selectApplicableRubricVersions({ query } as never, { ...request, contractId: undefined });
    expect(query.mock.calls[0]![1][1]).toBeNull();
  });

  it('fails closed on unsupported modes before querying', async () => {
    const query = vi.fn();
    await expect(selectApplicableRubricVersions({ query } as never, { ...request, mode: 'SPACE' }))
      .rejects.toMatchObject({ code: 'RUBRIC_APPLICABILITY_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
