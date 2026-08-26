import { describe, expect, it, vi } from 'vitest';
import { storeRubricSnapshot } from '../../src/modules/rubric-resolver/store-rubric-snapshot.js';

const document = { schemaVersion: 1, resolverVersion: 'resolver-v1', criteria: [{ criterionKey: 'STD.X' }] };

describe('rubric snapshot content deduplication', () => {
  it('returns the newly inserted immutable snapshot', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'snapshot-1' }] });
    const result = await storeRubricSnapshot({ query } as never, null, document);
    expect(result).toMatchObject({ id: 'snapshot-1', created: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(query.mock.calls[0]![0]).toContain('ON CONFLICT (tenant_id, content_hash) DO NOTHING');
  });

  it('returns the existing row for retry-equivalent canonical content', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'snapshot-1', resolved_doc: document, resolver_version: 'resolver-v1' }] });
    await expect(storeRubricSnapshot({ query } as never, null, document)).resolves.toMatchObject({ id: 'snapshot-1', created: false });
    expect(query.mock.calls[1]![0]).toContain('tenant_id IS NOT DISTINCT FROM $1::uuid');
  });

  it('fails closed if an existing hash resolves to different content', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'snapshot-1', resolved_doc: { ...document, criteria: [] }, resolver_version: 'resolver-v1' }] });
    await expect(storeRubricSnapshot({ query } as never, null, document))
      .rejects.toMatchObject({ code: 'RUBRIC_SNAPSHOT_HASH_CONFLICT' });
  });
});
