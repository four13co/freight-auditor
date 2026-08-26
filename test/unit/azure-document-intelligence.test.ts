import { describe, expect, it, vi } from 'vitest';
import {
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
  AzureDocumentIntelligenceAdapter,
  AzureDocumentIntelligenceError,
  azureDocumentIntelligenceFromEnv,
} from '../../src/modules/contracts/azure-document-intelligence.js';

const endpoint = 'https://example.cognitiveservices.azure.com';
const operationLocation = `${endpoint}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-1?api-version=${AZURE_DOCUMENT_INTELLIGENCE_API_VERSION}`;
const complete = { status: 'succeeded', analyzeResult: { apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION, modelId: 'prebuilt-layout', content: 'contract' } };

describe('AzureDocumentIntelligenceAdapter provider contract', () => {
  it('submits pinned binary analysis, polls to completion, and returns raw evidence', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'operation-location': operationLocation } }))
      .mockResolvedValueOnce(Response.json({ status: 'running' }, { headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(Response.json(complete));
    const adapter = new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, fetchImpl, sleep);
    const result = await adapter.analyze({ bytes: Buffer.from('pdf'), contentType: 'application/pdf' });

    const [submitUrl, submitInit] = fetchImpl.mock.calls[0]!;
    expect(String(submitUrl)).toContain(`prebuilt-layout:analyze?api-version=${AZURE_DOCUMENT_INTELLIGENCE_API_VERSION}`);
    expect(submitInit).toMatchObject({ method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': 'secret', 'Content-Type': 'application/pdf' } });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result).toMatchObject({ provider: 'azure-document-intelligence', modelId: 'prebuilt-layout', rawResponse: complete });
  });

  it('resumes an accepted operation without creating a duplicate analysis call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(complete));
    const result = await new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, fetchImpl)
      .analyze({ operationLocation });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).not.toMatchObject({ method: 'POST' });
    expect(result.operationLocation).toBe(operationLocation);
  });

  it('fails closed on missing input, untrusted operation URLs, and model pin mismatches', async () => {
    const adapter = new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, vi.fn());
    await expect(adapter.analyze({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(adapter.analyze({ operationLocation: 'https://attacker.example/result' })).rejects.toMatchObject({ code: 'INVALID_OPERATION_LOCATION' });
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...complete, analyzeResult: { ...complete.analyzeResult, modelId: 'other' } }));
    await expect(new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, fetchImpl).analyze({ operationLocation }))
      .rejects.toMatchObject({ code: 'PIN_MISMATCH' });
  });

  it('classifies throttling as retryable and validation failures as permanent', async () => {
    const throttled = vi.fn().mockResolvedValue(Response.json({ error: { code: 'TooManyRequests', message: 'slow down' } }, { status: 429 }));
    await expect(new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, throttled)
      .analyze({ bytes: Buffer.from('pdf'), contentType: 'application/pdf' }))
      .rejects.toMatchObject({ code: 'TooManyRequests', retryable: true });

    const invalid = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'operation-location': operationLocation } }))
      .mockResolvedValueOnce(Response.json({ hello: 'world' }));
    await expect(new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, invalid)
      .analyze({ bytes: Buffer.from('pdf'), contentType: 'application/pdf' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it('returns stable failed/timeout errors and caps retry delays', async () => {
    const failed = vi.fn().mockResolvedValue(Response.json({ status: 'failed', error: { code: 'BadDocument', message: 'unreadable' } }));
    await expect(new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret' }, failed)
      .analyze({ operationLocation })).rejects.toEqual(expect.objectContaining({ code: 'BadDocument', retryable: false }));

    const sleep = vi.fn().mockResolvedValue(undefined);
    const running = vi.fn().mockResolvedValue(Response.json({ status: 'running' }, { headers: { 'retry-after': '999' } }));
    await expect(new AzureDocumentIntelligenceAdapter({ endpoint, apiKey: 'secret', maxPollAttempts: 1 }, running, sleep)
      .analyze({ operationLocation })).rejects.toMatchObject({ code: 'POLL_TIMEOUT', retryable: true });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('validates configuration without exposing credentials', () => {
    expect(() => new AzureDocumentIntelligenceAdapter({ endpoint: 'http://insecure.test', apiKey: 'secret' })).toThrow(/https/);
    expect(() => azureDocumentIntelligenceFromEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: endpoint })).toThrow(/KEY/);
    expect(new AzureDocumentIntelligenceError('x', 'safe', false).message).toBe('safe');
  });
});
