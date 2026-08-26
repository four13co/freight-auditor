import { describe, expect, it } from 'vitest';
import { LocalDiskObjectStore } from '../../src/modules/reference-data/object-store.js';
import { R2ObjectStore } from '../../src/modules/reference-data/r2-object-store.js';
import { configuredObjectStore } from '../../src/modules/reference-data/configured-object-store.js';

describe('configuredObjectStore', () => {
  it('uses local disk when R2 is not configured', () => {
    expect(configuredObjectStore('/tmp/contracts', {})).toBeInstanceOf(LocalDiskObjectStore);
  });
  it('uses Cloudflare R2 when its complete credential set is configured', () => {
    expect(configuredObjectStore('/tmp/contracts', {
      CLOUDFLARE_ACCOUNT_ID: 'account', R2_BUCKET: 'bucket',
      R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret',
    })).toBeInstanceOf(R2ObjectStore);
  });
});
