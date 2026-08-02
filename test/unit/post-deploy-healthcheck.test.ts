import { describe, it, expect, vi } from 'vitest';
import { pollHealth } from '../../scripts/post-deploy-healthcheck.mjs';

function fakeResponse(build: string | null) {
  return { json: async () => (build === null ? {} : { status: 'ok', build }) } as Response;
}

describe('pollHealth (unit)', () => {
  it('reports healthy as soon as the expected build SHA is observed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('sha-new'));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      fetchImpl,
      sleepImpl,
    });

    expect(result).toEqual({ healthy: true, lastBuild: 'sha-new', attempts: 1 });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('keeps polling while the old revision is still being served mid rolling-swap', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse('sha-old'))
      .mockResolvedValueOnce(fakeResponse('sha-old'))
      .mockResolvedValueOnce(fakeResponse('sha-new'));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      retries: 5,
      fetchImpl,
      sleepImpl,
    });

    expect(result).toEqual({ healthy: true, lastBuild: 'sha-new', attempts: 3 });
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('reports unhealthy once retries are exhausted without ever matching', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('sha-old'));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      retries: 4,
      fetchImpl,
      sleepImpl,
    });

    expect(result).toEqual({ healthy: false, lastBuild: 'sha-old', attempts: 4 });
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a transient fetch failure as "not yet healthy" and keeps polling', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(fakeResponse('sha-new'));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      retries: 5,
      fetchImpl,
      sleepImpl,
    });

    expect(result).toEqual({ healthy: true, lastBuild: 'sha-new', attempts: 2 });
  });

  it('reports unhealthy with lastBuild null when the endpoint never returns a build field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(null));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      retries: 2,
      fetchImpl,
      sleepImpl,
    });

    expect(result).toEqual({ healthy: false, lastBuild: null, attempts: 2 });
  });
});
