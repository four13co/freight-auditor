import { describe, expect, it, vi } from 'vitest';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { S3ObjectStore, sha256Hex } from '../../src/modules/reference-data/object-store.js';

function clientWithSend(send: ReturnType<typeof vi.fn>): S3Client {
  return { send } as unknown as S3Client;
}

describe('S3ObjectStore (Cloudflare R2-compatible)', () => {
  it('conditionally creates a content-addressed object and returns its stable URI', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = new S3ObjectStore({ client: clientWithSend(send), bucket: 'freight-evidence', prefix: '/raw/' });
    const bytes = Buffer.from('invoice');
    const sha256 = sha256Hex(bytes);

    await expect(store.put(bytes)).resolves.toEqual({
      sha256,
      uri: `s3://freight-evidence/raw/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
      byteSize: bytes.byteLength,
    });

    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'freight-evidence',
      Key: `raw/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
      Body: bytes,
      ContentLength: bytes.byteLength,
      IfNoneMatch: '*',
    });
  });

  it('treats a concurrent conditional-write conflict as idempotent success', async () => {
    const conflict = Object.assign(new Error('already exists'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
    const store = new S3ObjectStore({
      client: clientWithSend(vi.fn().mockRejectedValue(conflict)),
      bucket: 'freight-evidence',
    });

    await expect(store.put(Buffer.from('same bytes'))).resolves.toMatchObject({ byteSize: 10 });
  });

  it('propagates provider failures other than conditional-write conflicts', async () => {
    const store = new S3ObjectStore({
      client: clientWithSend(vi.fn().mockRejectedValue(new Error('R2 unavailable'))),
      bucket: 'freight-evidence',
    });

    await expect(store.put(Buffer.from('invoice'))).rejects.toThrow('R2 unavailable');
  });

  it('checks existence with HeadObject and maps only missing-object errors to false', async () => {
    const foundSend = vi.fn().mockResolvedValue({});
    const found = new S3ObjectStore({ client: clientWithSend(foundSend), bucket: 'freight-evidence' });
    const sha256 = 'a'.repeat(64);
    await expect(found.has(sha256)).resolves.toBe(true);
    expect(foundSend.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);

    const missing = Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    const absent = new S3ObjectStore({
      client: clientWithSend(vi.fn().mockRejectedValue(missing)),
      bucket: 'freight-evidence',
    });
    await expect(absent.has(sha256)).resolves.toBe(false);

    const denied = new S3ObjectStore({
      client: clientWithSend(vi.fn().mockRejectedValue(new Error('access denied'))),
      bucket: 'freight-evidence',
    });
    await expect(denied.has(sha256)).rejects.toThrow('access denied');
  });

  it('reads the complete response body into a Buffer', async () => {
    const body = { transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('invoice'))) };
    const send = vi.fn().mockResolvedValue({ Body: body });
    const store = new S3ObjectStore({ client: clientWithSend(send), bucket: 'freight-evidence' });

    await expect(store.get('b'.repeat(64))).resolves.toEqual(Buffer.from('invoice'));
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
  });

  it('fails closed on invalid bucket, prefix, hash, and missing response body', async () => {
    const client = clientWithSend(vi.fn().mockResolvedValue({}));
    expect(() => new S3ObjectStore({ client, bucket: 'bad/name' })).toThrow('S3 bucket');
    expect(() => new S3ObjectStore({ client, bucket: 'ok', prefix: 'bad\u0000prefix' })).toThrow('S3 object prefix');

    const store = new S3ObjectStore({ client, bucket: 'ok' });
    await expect(store.has('not-a-hash')).rejects.toThrow('sha256');
    await expect(store.get('c'.repeat(64))).rejects.toThrow('empty response body');
  });
});
