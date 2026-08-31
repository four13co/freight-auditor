import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const DATABASE_URL = process.env.TEST_DATABASE_URL;

// Skipped whenever TEST_DATABASE_URL isn't set — these need a live ephemeral Postgres
// (the loop's throwaway per-item local DB) and are never run against a shared/protected
// host. This is why `npm test` reports 5 skipped by default: this describe block's tests
// run explicitly via `npm run test:db`/CI's DB job, not the default gated suite (86e2u72u2).
describe.skipIf(!DATABASE_URL)('migrate-database job (e2e, ephemeral local Postgres)', () => {
  it('guard-protected-db.mjs passes on the ephemeral local host', async () => {
    await expect(
      run('node', ['scripts/guard-protected-db.mjs'], {
        env: { ...process.env, DATABASE_URL },
      }),
    ).resolves.toBeDefined();
  });

  it('guard-protected-db.mjs rejects a protected host and does not run migrations', async () => {
    await expect(
      run('node', ['scripts/guard-protected-db.mjs'], {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/db',
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Refusing to run against protected host'),
    });
  });

  it('applies migrations cleanly against a fresh database', async () => {
    const { stdout } = await run('npm', ['run', 'migrate', 'up'], {
      env: { ...process.env, DATABASE_URL },
    });
    expect(stdout).toBeDefined();
  });

  it('is a clean no-op when all migrations are already applied', async () => {
    const { stdout, stderr } = await run('npm', ['run', 'migrate', 'up'], {
      env: { ...process.env, DATABASE_URL },
    });
    expect(`${stdout}${stderr}`).not.toMatch(/error/i);
  });

  describe('a broken migration fails loudly', () => {
    let tmpMigrationsDir: string;

    beforeAll(async () => {
      tmpMigrationsDir = await mkdtemp(join(tmpdir(), 'fa-broken-migration-'));
      await writeFile(
        join(tmpMigrationsDir, '9999999999999_broken.sql'),
        '-- Up Migration\nTHIS IS NOT VALID SQL;\n',
      );
    });

    it('exits non-zero with the SQL error visible', async () => {
      await expect(
        run('npx', ['node-pg-migrate', 'up', '-m', tmpMigrationsDir, '--no-check-order'], {
          env: { ...process.env, DATABASE_URL },
        }),
      ).rejects.toMatchObject({ code: expect.any(Number) });
    });
  });

  /**
   * 86e2unvbv: deploy.yml's migrate-database job races itself when two pushes
   * land close together -- both `npm run migrate up` invocations grab
   * node-pg-migrate's advisory lock, the loser fails with "Another migration
   * is already running" and no retry, silently skipping that deploy (see the
   * item for the confirmed CI incident across PRs #46/#47/#48). `npm run
   * migrate` now wraps node-pg-migrate with migrate-with-retry.mjs, which
   * retries ONLY that specific lock error -- these ACs run two REAL
   * concurrent OS processes against a live ephemeral Postgres (a mocked
   * client can't prove an actual process-level race resolves cleanly).
   */
  describe('concurrent migrate invocations no longer race (86e2unvbv)', () => {
    let tmpMigrationsDir: string;

    beforeAll(async () => {
      // A slow no-op migration gives both concurrent processes a wide enough
      // window to actually contend for the lock, rather than one finishing
      // before the other even starts.
      tmpMigrationsDir = await mkdtemp(join(tmpdir(), 'fa-race-migration-'));
      await writeFile(
        join(tmpMigrationsDir, '9999999999998_slow_noop.sql'),
        '-- Up Migration\nSELECT pg_sleep(1);\n',
      );
    });

    it('AC1: two pushes landing close together both exit 0 (neither fails on lock contention)', async () => {
      const invoke = () =>
        run('node', ['scripts/migrate-with-retry.mjs', 'up', '-m', tmpMigrationsDir, '--no-check-order'], {
          env: { ...process.env, DATABASE_URL },
        });

      const results = await Promise.allSettled([invoke(), invoke()]);
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }
    });

    it('AC2: a single push (no contention) still applies cleanly and exits 0', async () => {
      await expect(
        run('node', ['scripts/migrate-with-retry.mjs', 'up', '-m', tmpMigrationsDir, '--no-check-order'], {
          env: { ...process.env, DATABASE_URL },
        }),
      ).resolves.toBeDefined();
    });
  });

  /**
   * 86e31e6vz: a migration merged out of numeric order, relative to what's
   * already applied on the target database, has broken three separate
   * deploys (#212, #217, #221) -- each required a reactive rename-and-re-PR
   * cycle to unblock. Runs in its own --migrations-schema, isolated from
   * this file's shared ephemeral DB and its other describe blocks' real
   * migration history, so the exact bug shape (a lower-numbered pending
   * file behind an already-applied higher one) reproduces regardless of
   * this file's run order.
   */
  describe('out-of-order migrations no longer block deploy (86e31e6vz)', () => {
    let tmpMigrationsDir: string;
    const migrationsSchema = `fa_test_checkorder_${Date.now()}`;

    beforeAll(async () => {
      tmpMigrationsDir = await mkdtemp(join(tmpdir(), 'fa-checkorder-'));
      // Applied first, alone -- establishes this as the high-water mark in
      // this isolated schema's own pgmigrations table.
      await writeFile(join(tmpMigrationsDir, '9999999999996_high.sql'), '-- Up Migration\nSELECT 1;\n');
      await run(
        'npx',
        [
          'node-pg-migrate',
          'up',
          '-m',
          tmpMigrationsDir,
          '--migrations-schema',
          migrationsSchema,
          '--create-migrations-schema',
        ],
        { env: { ...process.env, DATABASE_URL } },
      );
      // Added afterward, numbered BELOW the file already applied above --
      // the exact shape of #212/#217/#221 (a same-day-merge race where the
      // slower PR's number sorts behind one the faster PR already pushed
      // past the applied high-water mark).
      await writeFile(join(tmpMigrationsDir, '9999999999995_low.sql'), '-- Up Migration\nSELECT 1;\n');
    });

    it('reproduces #212/#217/#221: checkOrder rejects the out-of-order pending file by default', async () => {
      await expect(
        run('npx', ['node-pg-migrate', 'up', '-m', tmpMigrationsDir, '--migrations-schema', migrationsSchema], {
          env: { ...process.env, DATABASE_URL },
        }),
      ).rejects.toMatchObject({
        code: expect.any(Number),
        stderr: expect.stringContaining('is preceding already run migration'),
      });
    });

    it('the real deploy invocation (migrate-with-retry + --no-check-order) applies it cleanly instead', async () => {
      await expect(
        run(
          'node',
          [
            'scripts/migrate-with-retry.mjs',
            'up',
            '-m',
            tmpMigrationsDir,
            '--migrations-schema',
            migrationsSchema,
            '--no-check-order',
          ],
          { env: { ...process.env, DATABASE_URL } },
        ),
      ).resolves.toBeDefined();
    });
  });
});
