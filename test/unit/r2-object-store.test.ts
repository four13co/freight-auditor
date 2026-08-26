import { describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { R2ObjectStore } from '../../src/modules/reference-data/r2-object-store.js';
import { sha256Hex } from '../../src/modules/reference-data/object-store.js';

const config = { accountId: 'account', bucket: 'contracts', accessKeyId: 'key', secretAccessKey: 'secret', prefix: '/raw/' };

describe('R2ObjectStore provider contract', () => {
  it('writes content once with a checksum and an overwrite precondition', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } };
      return {};
    });
    const store = new R2ObjectStore(config, { send });
    const bytes = Buffer.from('immutable contract');
    const result = await store.put(bytes);
    const put = send.mock.calls.map(([command]) => command).find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: 'contracts', IfNoneMatch: '*', Metadata: { sha256: sha256Hex(bytes) } });
    expect(result.uri).toContain(`r2://contracts/raw/`);
  });

  it('treats a precondition race as an idempotent success', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } };
      throw { $metadata: { httpStatusCode: 412 } };
    });
    await expect(new R2ObjectStore(config, { send }).put(Buffer.from('same'))).resolves.toMatchObject({ byteSize: 4 });
  });

  it('does not PUT when the object already exists and returns retrieved bytes', async () => {
    const send = vi.fn(async (command: object) => command instanceof GetObjectCommand
      ? { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
      : {});
    const store = new R2ObjectStore(config, { send });
    await expect(store.has('a'.repeat(64))).resolves.toBe(true);
    await expect(store.get('a'.repeat(64))).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('propagates provider failures other than not-found/precondition and rejects empty bodies', async () => {
    const failure = new Error('provider down');
    await expect(new R2ObjectStore(config, { send: vi.fn().mockRejectedValue(failure) }).has('a'.repeat(64))).rejects.toBe(failure);
    const store = new R2ObjectStore(config, { send: vi.fn().mockResolvedValue({}) });
    await expect(store.get('a'.repeat(64))).rejects.toThrow('R2_OBJECT_BODY_MISSING');
  });
});
