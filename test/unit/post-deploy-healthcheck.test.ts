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
    // sha-old is not a later commit than sha-new, so the superseded check (AC2) must
    // reject it and this must still report a genuine failure.
    const runImpl = vi.fn().mockRejectedValue(new Error('fatal: not an ancestor'));

    const result = await pollHealth({
      healthUrl: 'http://app.test/health',
      expectedBuild: 'sha-new',
      retries: 4,
      fetchImpl,
      sleepImpl,
      runImpl,
    });

    expect(result).toEqual({ healthy: false, lastBuild: 'sha-old', attempts: 4 });
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  describe('superseded-build tolerance (86e2tmq3n AC2)', () => {
    it('treats a later, healthy deploy observed during the poll as superseded, not a failure', async () => {
      // Reproduces the logged race: PR #24 (f3b1bae) was still polling when PR #29
      // (7e8a95a) landed and deployed healthy first, so the poller for f3b1bae saw
      // 7e8a95a as "last observed build" and would otherwise report failure + trigger
      // a rollback of a healthy app.
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('sha-newer-healthy'));
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      const runImpl = vi.fn().mockResolvedValue({ stdout: '' }); // git merge-base --is-ancestor: exit 0

      const result = await pollHealth({
        healthUrl: 'http://app.test/health',
        expectedBuild: 'sha-expected-superseded',
        retries: 3,
        fetchImpl,
        sleepImpl,
        runImpl,
      });

      expect(result).toEqual({
        healthy: true,
        lastBuild: 'sha-newer-healthy',
        attempts: 3,
        superseded: true,
      });
      expect(runImpl).toHaveBeenCalledWith('git', [
        'merge-base',
        '--is-ancestor',
        'sha-expected-superseded',
        'sha-newer-healthy',
      ]);
    });

    it('does not trigger the superseded path when the observed build is not provably a descendant', async () => {
      // A genuinely broken deploy also never matches expectedBuild — this must not be
      // mistaken for a race just because the SHAs differ.
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('sha-unrelated-or-older'));
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      const runImpl = vi.fn().mockRejectedValue(new Error('fatal: not an ancestor')); // git exits non-zero

      const result = await pollHealth({
        healthUrl: 'http://app.test/health',
        expectedBuild: 'sha-expected',
        retries: 3,
        fetchImpl,
        sleepImpl,
        runImpl,
      });

      expect(result).toEqual({ healthy: false, lastBuild: 'sha-unrelated-or-older', attempts: 3 });
    });

    it('never runs the ancestry check when the expected build is already observed healthy', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse('sha-new'));
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      const runImpl = vi.fn();

      await pollHealth({
        healthUrl: 'http://app.test/health',
        expectedBuild: 'sha-new',
        retries: 3,
        fetchImpl,
        sleepImpl,
        runImpl,
      });

      expect(runImpl).not.toHaveBeenCalled();
    });
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
