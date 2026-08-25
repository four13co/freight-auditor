import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * Immutable, content-addressed blob storage for raw EDI + contract PDFs
 * (Master Spec §6.3, §6.9 — the immutable source layer Phase 0 must provide).
 *
 * The store is addressed by the sha256 of the bytes: storing the same bytes
 * twice yields the same URI and writes once (idempotent). Blobs are never
 * mutated or deleted — "edits" upstream become new documents.
 *
 * The backend is pluggable behind {@link ObjectStore}; prod may use an
 * S3-compatible store while dev uses local disk. Callers depend only on the
 * interface.
 */
export interface ObjectStore {
  /**
   * Store `bytes` and return its content address. Idempotent: re-storing
   * identical bytes returns the same URI without a second write.
   */
  put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }>;
  /** Fetch bytes by their sha256. Throws if absent. */
  get(sha256: string): Promise<Buffer>;
  /** Whether a blob with this sha256 already exists. */
  has(sha256: string): Promise<boolean>;
}

/** The sha256 hex digest of `bytes`. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Local-disk {@link ObjectStore} for development / tests. Content-addressed
 * fan-out: <root>/ab/cd/<full-sha>. Prod swaps this for an S3-backed impl
 * behind the same interface.
 */
export class LocalDiskObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  uriFor(sha256: string): string {
    return `file://${this.pathFor(sha256)}`;
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await access(this.pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  }

  async put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }> {
    const sha256 = sha256Hex(bytes);
    const path = this.pathFor(sha256);
    if (!(await this.has(sha256))) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return { sha256, uri: this.uriFor(sha256), byteSize: bytes.byteLength };
  }

  async get(sha256: string): Promise<Buffer> {
    return readFile(this.pathFor(sha256));
  }
}

export interface S3ObjectStoreOptions {
  /** An SDK client configured for the target S3-compatible service. */
  client: S3Client;
  bucket: string;
  /** Optional namespace within the bucket, without leading/trailing slashes. */
  prefix?: string;
}

/**
 * Production content-addressed storage backed by an S3-compatible API.
 *
 * Cloudflare R2 is the production target. The caller configures the SDK with
 * R2's account endpoint and `region: "auto"`; keeping that configuration out
 * of this adapter preserves the ObjectStore boundary and leaves bucket/runtime
 * selection to the configuration task.
 *
 * Writes use `If-None-Match: *`, which R2 supports for PutObject. Concurrent
 * writers of identical bytes race safely: one creates the hash-addressed key
 * and the others receive 412, which is success for this immutable API.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3ObjectStoreOptions) {
    this.client = options.client;
    this.bucket = validateBucket(options.bucket);
    this.prefix = normalizePrefix(options.prefix);
  }

  keyFor(sha256: string): string {
    validateSha256(sha256);
    const contentKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    return this.prefix === '' ? contentKey : `${this.prefix}/${contentKey}`;
  }

  uriFor(sha256: string): string {
    return `s3://${this.bucket}/${this.keyFor(sha256)}`;
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(sha256) }));
      return true;
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  async put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }> {
    const sha256 = sha256Hex(bytes);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(sha256),
        Body: bytes,
        ContentLength: bytes.byteLength,
        IfNoneMatch: '*',
      }));
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
    return { sha256, uri: this.uriFor(sha256), byteSize: bytes.byteLength };
  }

  async get(sha256: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(sha256),
    }));
    if (!response.Body) throw new Error(`object ${sha256} returned an empty response body`);
    return Buffer.from(await response.Body.transformToByteArray());
  }
}

function validateBucket(bucket: string): string {
  const value = bucket.trim();
  if (value === '' || value.includes('/') || containsControlCharacter(value)) {
    throw new Error('S3 bucket must be a non-empty name without slashes or control characters');
  }
  return value;
}

function normalizePrefix(prefix: string | undefined): string {
  const value = (prefix ?? '').replace(/^\/+|\/+$/gu, '');
  if (containsControlCharacter(value)) {
    throw new Error('S3 object prefix must not contain control characters');
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validateSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('sha256 must be 64 lowercase hexadecimal characters');
}

function errorDetails(error: unknown): { name?: string; code?: string; status?: number } {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    code: typeof candidate.Code === 'string'
      ? candidate.Code
      : typeof candidate.code === 'string' ? candidate.code : undefined,
    status: typeof candidate.$metadata?.httpStatusCode === 'number'
      ? candidate.$metadata.httpStatusCode
      : undefined,
  };
}

function isMissingObject(error: unknown): boolean {
  const { name, code, status } = errorDetails(error);
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchKey';
}

function isPreconditionFailed(error: unknown): boolean {
  const { name, code, status } = errorDetails(error);
  return status === 412 || name === 'PreconditionFailed' || code === 'PreconditionFailed';
}
