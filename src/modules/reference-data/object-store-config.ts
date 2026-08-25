import { S3Client } from '@aws-sdk/client-s3';
import { LocalDiskObjectStore, S3ObjectStore, type ObjectStore } from './object-store.js';

type Environment = Record<string, string | undefined>;

export type ObjectStoreBackend = 'local' | 'r2';

export interface ObjectStoreConfiguration {
  backend: ObjectStoreBackend;
  localRoot?: string;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    prefix?: string;
    endpoint: string;
  };
}

/** Parse and validate storage configuration without constructing a client. */
export function readObjectStoreConfiguration(env: Environment = process.env): ObjectStoreConfiguration {
  const configuredBackend = env.OBJECT_STORE_BACKEND?.trim().toLowerCase();
  if (configuredBackend === undefined || configuredBackend === '') {
    if (env.NODE_ENV === 'production') {
      throw new Error('OBJECT_STORE_BACKEND is required in production (expected "r2")');
    }
    return { backend: 'local', localRoot: env.OBJECT_STORE_ROOT ?? './.data/object-store' };
  }
  if (configuredBackend === 'local') {
    return { backend: 'local', localRoot: requireValue(env, 'OBJECT_STORE_ROOT', 'local') };
  }
  if (configuredBackend !== 'r2') {
    throw new Error(`unsupported OBJECT_STORE_BACKEND: ${configuredBackend}`);
  }

  const accountId = requireValue(env, 'R2_ACCOUNT_ID', 'r2');
  const endpoint = env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  validateHttpsUrl(endpoint, 'R2_ENDPOINT');
  return {
    backend: 'r2',
    r2: {
      accountId,
      accessKeyId: requireValue(env, 'R2_ACCESS_KEY_ID', 'r2'),
      secretAccessKey: requireValue(env, 'R2_SECRET_ACCESS_KEY', 'r2'),
      bucket: requireValue(env, 'R2_BUCKET', 'r2'),
      prefix: env.R2_PREFIX?.trim() || undefined,
      endpoint,
    },
  };
}

/** Construct the configured backend. Cloudflare R2 uses region `auto`. */
export function createObjectStore(env: Environment = process.env): ObjectStore {
  const config = readObjectStoreConfiguration(env);
  if (config.backend === 'local') return new LocalDiskObjectStore(config.localRoot!);

  const r2 = config.r2!;
  const client = new S3Client({
    region: 'auto',
    endpoint: r2.endpoint,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });
  return new S3ObjectStore({ client, bucket: r2.bucket, prefix: r2.prefix });
}

let runtimeStore: ObjectStore | undefined;

/** One process-wide store/client, shared by every upload route. */
export function runtimeObjectStore(): ObjectStore {
  runtimeStore ??= createObjectStore();
  return runtimeStore;
}

/** Test-only lifecycle seam; production code must not rotate a live store. */
export function resetRuntimeObjectStore(): void {
  runtimeStore = undefined;
}

function requireValue(env: Environment, name: string, backend: ObjectStoreBackend): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when OBJECT_STORE_BACKEND=${backend}`);
  return value;
}

function validateHttpsUrl(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
}
