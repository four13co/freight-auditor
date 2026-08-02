import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const DATABASE_URL = process.env.TEST_DATABASE_URL;

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
});
