import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listClientClaimDocuments } from '../../src/modules/portal/list-client-claim-documents.js';

const CLIENT_ID = 'client-abc';
const CLAIM_ID = '60000000-0000-4000-8000-000000000001';

function mockClient(opts: { claimRows?: unknown[]; docRows?: unknown[] }) {
  const { claimRows = [], docRows = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM claim WHERE client_id')) return Promise.resolve({ rows: claimRows, rowCount: claimRows.length });
    if (sql.includes('FROM claim c')) return Promise.resolve({ rows: docRows });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listClientClaimDocuments (unit, mocked client)', () => {
  it('returns null when the claim does not exist / is not visible to this clientId', async () => {
    const { client } = mockClient({ claimRows: [] });
    const result = await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    expect(result).toBeNull();
  });

  it('returns mapped document refs when the claim resolves documents', async () => {
    const { client } = mockClient({
      claimRows: [{ id: CLAIM_ID }],
      docRows: [{ id: 'doc-1', sha256: 'a'.repeat(64), storage_uri: 'r2://doc-1' }],
    });
    const result = await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    expect(result).toEqual([{ id: 'doc-1', sha256: 'a'.repeat(64), storageUri: 'r2://doc-1' }]);
  });

  it('returns an empty array when the claim exists but resolves no documents (no dispute, or no source_document yet)', async () => {
    const { client } = mockClient({ claimRows: [{ id: CLAIM_ID }], docRows: [] });
    const result = await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    expect(result).toEqual([]);
  });

  it('binds clientId and claimId as the claim-existence check params, in that order', async () => {
    const { client, query } = mockClient({ claimRows: [] });
    await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE client_id = \$1 AND id = \$2/);
    expect(params).toEqual([CLIENT_ID, CLAIM_ID]);
  });

  it('binds clientId and claimId as the document-resolution query params, in that order', async () => {
    const { client, query } = mockClient({ claimRows: [{ id: CLAIM_ID }], docRows: [] });
    await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    const docCall = query.mock.calls.find((c) => (c[0] as string).includes('FROM claim c')) as [string, unknown[]];
    expect(docCall[0]).toMatch(/WHERE c\.client_id = \$1 AND c\.id = \$2/);
    expect(docCall[1]).toEqual([CLIENT_ID, CLAIM_ID]);
  });

  it('joins through dispute_line and variance_finding so a findingless or document-less line is silently dropped, not an error', async () => {
    // The query itself expresses this via INNER JOINs (a NULL dispute_id/
    // variance_finding_id/source_document_id simply fails to match) --
    // this test documents that contract at the SQL-shape level, since a
    // mocked client can't exercise the join semantics directly.
    const { client, query } = mockClient({ claimRows: [{ id: CLAIM_ID }], docRows: [] });
    await listClientClaimDocuments(client, CLIENT_ID, CLAIM_ID);
    const docCall = query.mock.calls.find((c) => (c[0] as string).includes('FROM claim c')) as [string, unknown[]];
    expect(docCall[0]).toMatch(/JOIN dispute_line dl ON dl\.client_id = c\.client_id AND dl\.dispute_id = c\.dispute_id/);
    expect(docCall[0]).toMatch(/JOIN variance_finding vf ON vf\.client_id = c\.client_id AND vf\.id = dl\.variance_finding_id/);
    expect(docCall[0]).toMatch(/JOIN source_document sd ON sd\.id = vf\.source_document_id/);
  });
});
