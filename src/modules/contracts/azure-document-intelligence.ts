import { z } from 'zod';

export const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION = '2024-11-30';
export const DEFAULT_AZURE_DOCUMENT_MODEL = 'prebuilt-layout';

const modelIdSchema = z.string().min(2).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._~-]+$/);
const azureResultSchema = z.object({
  status: z.enum(['notStarted', 'running', 'succeeded', 'failed']),
  createdDateTime: z.string().optional(),
  lastUpdatedDateTime: z.string().optional(),
  analyzeResult: z.object({
    apiVersion: z.string(),
    modelId: z.string(),
    content: z.string().optional(),
    pages: z.array(z.unknown()).optional(),
    tables: z.array(z.unknown()).optional(),
    paragraphs: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
}).passthrough();

export interface AzureDocumentIntelligenceConfig {
  endpoint: string;
  apiKey: string;
  modelId?: string;
  maxPollAttempts?: number;
  defaultPollDelayMs?: number;
}

export interface AzureAnalyzeInput {
  bytes?: Buffer;
  contentType?: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  /** Resume a previously accepted operation without creating another call. */
  operationLocation?: string;
}

export interface AzureAnalyzeResult {
  provider: 'azure-document-intelligence';
  apiVersion: string;
  modelId: string;
  operationLocation: string;
  rawResponse: z.infer<typeof azureResultSchema>;
}

export class AzureDocumentIntelligenceError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message); this.name = 'AzureDocumentIntelligenceError';
  }
}

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export class AzureDocumentIntelligenceAdapter {
  private readonly endpoint: URL;
  private readonly modelId: string;
  private readonly maxPollAttempts: number;
  private readonly defaultPollDelayMs: number;

  constructor(
    private readonly config: AzureDocumentIntelligenceConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.protocol !== 'https:') throw new Error('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT must use https');
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/+$/, '');
    if (!config.apiKey.trim()) throw new Error('AZURE_DOCUMENT_INTELLIGENCE_KEY is required');
    this.modelId = modelIdSchema.parse(config.modelId ?? DEFAULT_AZURE_DOCUMENT_MODEL);
    this.maxPollAttempts = config.maxPollAttempts ?? 60;
    this.defaultPollDelayMs = config.defaultPollDelayMs ?? 1_000;
  }

  async analyze(input: AzureAnalyzeInput): Promise<AzureAnalyzeResult> {
    let operationLocation = input.operationLocation;
    if (!operationLocation) {
      if (!input.bytes?.byteLength || !input.contentType) {
        throw new AzureDocumentIntelligenceError('INVALID_INPUT', 'document bytes and content type are required', false);
      }
      const url = new URL(`${this.endpoint.pathname}/documentintelligence/documentModels/${encodeURIComponent(this.modelId)}:analyze`, this.endpoint);
      url.searchParams.set('api-version', AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
      url.searchParams.set('outputContentFormat', 'text');
      // web/'s DOM-lib tsconfig types fetch's BodyInit without Node's Buffer in
      // the union (root's plain tsc --noEmit passes the identical file clean),
      // and TS's now-generic Uint8Array<ArrayBufferLike> doesn't satisfy DOM's
      // BodyInit either -- an actual ArrayBuffer copy of exactly this Buffer's
      // bytes (not the whole, possibly-pooled backing buffer) is unambiguous in
      // both environments' typings, with no behavior change.
      const bytes = input.bytes;
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': this.config.apiKey, 'Content-Type': input.contentType },
        body,
      });
      if (response.status !== 202) throw await providerError(response, 'ANALYZE_REJECTED');
      operationLocation = response.headers.get('operation-location') ?? undefined;
      if (!operationLocation) throw new AzureDocumentIntelligenceError('MISSING_OPERATION_LOCATION', 'Azure response omitted operation-location', true);
    }

    const operationUrl = new URL(operationLocation);
    if (operationUrl.origin !== this.endpoint.origin || operationUrl.protocol !== 'https:') {
      throw new AzureDocumentIntelligenceError('INVALID_OPERATION_LOCATION', 'Azure operation location is outside the configured endpoint', false);
    }

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const response = await this.fetchImpl(operationUrl, { headers: { 'Ocp-Apim-Subscription-Key': this.config.apiKey } });
      if (!response.ok) throw await providerError(response, 'POLL_REJECTED');
      const parsed = azureResultSchema.safeParse(await response.json());
      if (!parsed.success) throw new AzureDocumentIntelligenceError('INVALID_RESPONSE', 'Azure returned an invalid analysis response', false);
      if (parsed.data.status === 'succeeded') {
        if (!parsed.data.analyzeResult || parsed.data.analyzeResult.apiVersion !== AZURE_DOCUMENT_INTELLIGENCE_API_VERSION || parsed.data.analyzeResult.modelId !== this.modelId) {
          throw new AzureDocumentIntelligenceError('PIN_MISMATCH', 'Azure response did not match the pinned API/model', false);
        }
        return { provider: 'azure-document-intelligence', apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
          modelId: this.modelId, operationLocation: operationUrl.toString(), rawResponse: parsed.data };
      }
      if (parsed.data.status === 'failed') {
        throw new AzureDocumentIntelligenceError(parsed.data.error?.code ?? 'ANALYSIS_FAILED', parsed.data.error?.message ?? 'Azure document analysis failed', false);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1_000, 30_000) : this.defaultPollDelayMs;
      await this.sleep(delay);
    }
    throw new AzureDocumentIntelligenceError('POLL_TIMEOUT', 'Azure document analysis did not complete within the poll limit', true);
  }
}

async function providerError(response: Response, fallbackCode: string): Promise<AzureDocumentIntelligenceError> {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  let message = `Azure Document Intelligence request failed (${response.status})`;
  try {
    const body = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional() }).passthrough().parse(await response.json());
    return new AzureDocumentIntelligenceError(body.error?.code ?? fallbackCode, body.error?.message ?? message, retryable);
  } catch {
    return new AzureDocumentIntelligenceError(fallbackCode, message, retryable);
  }
}

export function azureDocumentIntelligenceFromEnv(env: Record<string, string | undefined> = process.env): AzureDocumentIntelligenceAdapter {
  return new AzureDocumentIntelligenceAdapter({
    endpoint: env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '',
    apiKey: env.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? '',
    modelId: env.AZURE_DOCUMENT_INTELLIGENCE_MODEL ?? DEFAULT_AZURE_DOCUMENT_MODEL,
  });
}
