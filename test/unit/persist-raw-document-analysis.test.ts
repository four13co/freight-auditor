import { describe, expect, it, vi } from 'vitest';
import { persistRawDocumentAnalysis, RawDocumentAnalysisConflictError } from '../../src/modules/contracts/persist-raw-document-analysis.js';
import { AZURE_DOCUMENT_INTELLIGENCE_API_VERSION } from '../../src/modules/contracts/azure-document-intelligence.js';

const input = {
  clientId: '11111111-1111-4111-8111-111111111111',
  sourceDocumentId: '22222222-2222-4222-8222-222222222222',
  actorUserId: null,
  result: {
    provider: 'azure-document-intelligence' as const,
    apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
    modelId: 'prebuilt-layout',
    operationLocation: 'https://example.cognitiveservices.azure.com/result/1',
    rawResponse: { status: 'succeeded' as const, analyzeResult: { modelId: 'prebuilt-layout', apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION, tables: [], content: 'contract' } },
  },
};

describe('persistRawDocumentAnalysis', () => {
  it('writes immutable raw evidence and one append-only audit event', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-4333-8333-333333333333', created: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event', created: true }] });
    const result = await persistRawDocumentAnalysis({ query } as never, input);
    expect(result.created).toBe(true);
    expect(result.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(query.mock.calls[0]![1][7]).toContain('"status":"succeeded"');
    expect(query.mock.calls[1]![0]).toContain('INSERT INTO audit_event');
  });

  it('returns an exact retry without duplicating its audit event', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: '33333333-3333-4333-8333-333333333333', created: false }] });
    await expect(persistRawDocumentAnalysis({ query } as never, input)).resolves.toMatchObject({ created: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an operation-location collision with different evidence', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(persistRawDocumentAnalysis({ query } as never, input)).rejects.toBeInstanceOf(RawDocumentAnalysisConflictError);
  });

  it('schema-rejects malformed untrusted evidence before querying', async () => {
    const query = vi.fn();
    await expect(persistRawDocumentAnalysis({ query } as never, { ...input, sourceDocumentId: 'bad' }))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
