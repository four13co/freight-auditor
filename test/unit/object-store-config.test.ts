import { afterEach, describe, expect, it } from 'vitest';
import { LocalDiskObjectStore, S3ObjectStore } from '../../src/modules/reference-data/object-store.js';
import {
  createObjectStore,
  readObjectStoreConfiguration,
  resetRuntimeObjectStore,
  runtimeObjectStore,
} from '../../src/modules/reference-data/object-store-config.js';

const R2_ENV = {
  OBJECT_STORE_BACKEND: 'r2',
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET: 'freight-evidence',
};

describe('object-store configuration', () => {
  afterEach(() => resetRuntimeObjectStore());

  it('defaults to local disk outside production and supports an explicit local root', () => {
    expect(readObjectStoreConfiguration({})).toEqual({
      backend: 'local',
      localRoot: './.data/object-store',
    });
    expect(createObjectStore({ OBJECT_STORE_BACKEND: 'local', OBJECT_STORE_ROOT: '/tmp/evidence' }))
      .toBeInstanceOf(LocalDiskObjectStore);
  });

  it('fails closed when production does not select a backend', () => {
    expect(() => readObjectStoreConfiguration({ NODE_ENV: 'production' }))
      .toThrow('OBJECT_STORE_BACKEND is required in production');
  });

  it('builds the Cloudflare R2 endpoint and S3-compatible store', () => {
    expect(readObjectStoreConfiguration(R2_ENV)).toEqual({
      backend: 'r2',
      r2: {
        accountId: 'account-id',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        bucket: 'freight-evidence',
        prefix: undefined,
        endpoint: 'https://account-id.r2.cloudflarestorage.com',
      },
    });
    expect(createObjectStore(R2_ENV)).toBeInstanceOf(S3ObjectStore);
  });

  it.each(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])(
    'rejects missing required R2 setting %s without including secret values',
    (name) => {
      expect(() => readObjectStoreConfiguration({ ...R2_ENV, [name]: ' ' })).toThrow(`${name} is required`);
    },
  );

  it('rejects unsupported backends and unsafe endpoint overrides', () => {
    expect(() => readObjectStoreConfiguration({ OBJECT_STORE_BACKEND: 'gcs' }))
      .toThrow('unsupported OBJECT_STORE_BACKEND');
    expect(() => readObjectStoreConfiguration({ ...R2_ENV, R2_ENDPOINT: 'http://localhost:9000' }))
      .toThrow('R2_ENDPOINT must be a credential-free HTTPS URL');
    expect(() => readObjectStoreConfiguration({ ...R2_ENV, R2_ENDPOINT: 'https://user:secret@example.com' }))
      .toThrow('R2_ENDPOINT must be a credential-free HTTPS URL');
  });

  it('returns one process-wide runtime store instance', () => {
    const priorBackend = process.env.OBJECT_STORE_BACKEND;
    const priorRoot = process.env.OBJECT_STORE_ROOT;
    process.env.OBJECT_STORE_BACKEND = 'local';
    process.env.OBJECT_STORE_ROOT = '/tmp/runtime-evidence';
    try {
      expect(runtimeObjectStore()).toBe(runtimeObjectStore());
    } finally {
      if (priorBackend === undefined) delete process.env.OBJECT_STORE_BACKEND;
      else process.env.OBJECT_STORE_BACKEND = priorBackend;
      if (priorRoot === undefined) delete process.env.OBJECT_STORE_ROOT;
      else process.env.OBJECT_STORE_ROOT = priorRoot;
    }
  });
});
