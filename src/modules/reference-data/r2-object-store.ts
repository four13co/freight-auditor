import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store.js';
import { sha256Hex } from './object-store.js';

export interface R2ObjectStoreConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

interface R2Client {
  send(command: object): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>;
}

/** Cloudflare R2's S3-compatible, immutable content-addressed object store. */
export class R2ObjectStore implements ObjectStore {
  private readonly client: R2Client;
  private readonly prefix: string;

  constructor(private readonly config: R2ObjectStoreConfig, client?: R2Client) {
    this.prefix = config.prefix?.replace(/^\/+|\/+$/g, '') ?? 'source-documents';
    this.client = client ?? new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }) as unknown as R2Client;
  }

  private key(sha256: string): string {
    return `${this.prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(sha256) }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  async put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }> {
    const sha256 = sha256Hex(bytes);
    const key = this.key(sha256);
    if (!(await this.has(sha256))) {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: bytes,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          Metadata: { sha256 },
        }));
      } catch (error) {
        // Another writer won the HEAD→PUT race. If-None-Match guarantees it
        // could not overwrite an existing immutable object.
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 412) throw error;
      }
    }
    return { sha256, uri: `r2://${this.config.bucket}/${key}`, byteSize: bytes.byteLength };
  }

  async get(sha256: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(sha256) }));
    if (!response.Body) throw new Error('R2_OBJECT_BODY_MISSING');
    return Buffer.from(await response.Body.transformToByteArray());
  }
}

export function r2ObjectStoreFromEnv(env: Record<string, string | undefined> = process.env): R2ObjectStore {
  const required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
  for (const key of required) if (!env[key]?.trim()) throw new Error(`${key} is required`);
  return new R2ObjectStore({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    bucket: env.R2_BUCKET!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    prefix: env.R2_SOURCE_PREFIX,
  });
}
