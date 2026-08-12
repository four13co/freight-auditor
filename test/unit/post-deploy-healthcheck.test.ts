import { describe, it, expect, vi } from 'vitest';
import { pollHealth, buildHealthUrl } from '../../scripts/post-deploy-healthcheck.mjs';

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

  it('fails fast on a malformed URL instead of burning the whole retry budget (86e25uqxa)', async () => {
    // A scheme-less APP_URL made every fetch throw ERR_INVALID_URL instantly. The old
    // blanket catch treated that exactly like a transient network blip, so CI spent
    // 6 minutes polling a URL that could never work and reported "last observed build:
    // none" — indistinguishable from a genuinely unhealthy app.
    // Uses the REAL fetch against a scheme-less URL so the test reproduces Node's actual
    // error shape rather than a hand-made stand-in that could drift from it.
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollHealth({
        healthUrl: 'app.test/health',
        expectedBuild: 'sha-new',
        retries: 36,
        sleepImpl,
      }),
    ).rejects.toThrow(/Cannot poll health endpoint/);

    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('still rides out a connection failure, which fetch also reports as a TypeError (86e25uqxa)', async () => {
    // Guards the narrowing above: undici wraps connection-refused in a TypeError too, so
    // keying the fail-fast path off `instanceof TypeError` would abort mid rolling-swap —
    // precisely the case this retry loop exists to survive.
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(connectionError)
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
});

describe('buildHealthUrl (unit, 86e25uqxa)', () => {
  // The 1Password vault stores bare hostnames — deploy.yml already prepends "https://"
  // to CapRover/url. app_url follows the same convention, so the scheme belongs here
  // rather than in the vault, keeping both URL fields consistent.
  it('prepends https:// to a bare hostname from the vault', () => {
    expect(buildHealthUrl('freight-auditor-dev.server.four13.dev')).toBe(
      'https://freight-auditor-dev.server.four13.dev/health',
    );
  });

  it('leaves an explicit scheme alone', () => {
    expect(buildHealthUrl('https://app.test')).toBe('https://app.test/health');
    expect(buildHealthUrl('http://app.test')).toBe('http://app.test/health');
  });

  it('does not double up slashes on a trailing-slash value', () => {
    expect(buildHealthUrl('https://app.test/')).toBe('https://app.test/health');
    expect(buildHealthUrl('app.test///')).toBe('https://app.test/health');
  });

  it('always produces a URL fetch can actually parse', () => {
    for (const raw of ['app.test', 'https://app.test/', 'http://app.test']) {
      expect(URL.canParse(buildHealthUrl(raw))).toBe(true);
    }
  });
});
