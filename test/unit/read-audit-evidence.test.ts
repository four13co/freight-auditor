import { describe, expect, it, vi } from 'vitest';
import { getInvoiceScorecard, getReplayManifest, getRubricSnapshot, listResolutionConflicts, listTenantResolutionConflicts } from '../../src/modules/audit-ledger/read-audit-evidence.js';

describe('audit evidence readers', () => {
  it('returns rows for each evidence projection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'row' }] });
    const client = { query } as never;
    await expect(getRubricSnapshot(client, 'run')).resolves.toEqual({ id: 'row' });
    await expect(listResolutionConflicts(client, 'run')).resolves.toEqual([{ id: 'row' }]);
    await expect(listTenantResolutionConflicts(client)).resolves.toEqual([{ id: 'row' }]);
    await expect(getReplayManifest(client, 'run')).resolves.toEqual({ id: 'row' });
    await expect(getInvoiceScorecard(client, 'run')).resolves.toEqual({ id: 'row' });
    expect(query).toHaveBeenCalledTimes(5);
  });
  it('returns null for absent singleton evidence', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    await expect(getRubricSnapshot(client, 'run')).resolves.toBeNull();
    await expect(getReplayManifest(client, 'run')).resolves.toBeNull();
    await expect(getInvoiceScorecard(client, 'run')).resolves.toBeNull();
  });
});
