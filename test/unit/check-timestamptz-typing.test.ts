import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findTimestamptzColumns,
  findMistypedColumns,
  checkAllTimestamptzTyping,
} from '../../scripts/check-timestamptz-typing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

describe('findTimestamptzColumns', () => {
  it('extracts a timestamptz column name from a CREATE TABLE body', () => {
    const sql = `
      CREATE TABLE claim (
        id uuid PRIMARY KEY,
        opened_at timestamptz NOT NULL DEFAULT now()
      );
    `;
    expect(findTimestamptzColumns([sql])).toEqual(new Set(['opened_at']));
  });

  it('accumulates across multiple files and ignores non-timestamptz columns', () => {
    const sqlA = `CREATE TABLE a (\n  recorded_at timestamptz\n);`;
    const sqlB = `CREATE TABLE b (\n  name text,\n  created_at timestamptz\n);`;
    expect(findTimestamptzColumns([sqlA, sqlB])).toEqual(new Set(['recorded_at', 'created_at']));
  });
});

describe('findMistypedColumns', () => {
  const timestamptzColumns = new Set(['opened_at', 'recorded_at']);

  it('reproduces the set-claim-aging-deadline.ts shape: a timestamptz column typed as string', () => {
    const content = `
      const { rows } = await client.query<{ opened_at: string }>(
        \`SELECT opened_at FROM claim WHERE id = $1\`,
        [id],
      );
    `;
    expect(findMistypedColumns(content, timestamptzColumns)).toEqual([
      { column: 'opened_at', declaredType: 'string' },
    ]);
  });

  it('flags a nullable string variant too', () => {
    const content = `client.query<{ recorded_at: string | null }>(sql);`;
    expect(findMistypedColumns(content, timestamptzColumns)).toEqual([
      { column: 'recorded_at', declaredType: 'string | null' },
    ]);
  });

  it('does not flag a column correctly typed as Date', () => {
    const content = `client.query<{ opened_at: Date }>(sql);`;
    expect(findMistypedColumns(content, timestamptzColumns)).toEqual([]);
  });

  it('does not flag a column not known to be timestamptz', () => {
    const content = `client.query<{ invoice_number: string }>(sql);`;
    expect(findMistypedColumns(content, timestamptzColumns)).toEqual([]);
  });

  it('flags multiple mistyped columns in the same generic', () => {
    const content = `client.query<{ id: string; opened_at: string; recorded_at: string }>(sql);`;
    expect(findMistypedColumns(content, timestamptzColumns)).toEqual([
      { column: 'opened_at', declaredType: 'string' },
      { column: 'recorded_at', declaredType: 'string' },
    ]);
  });
});

describe('checkAllTimestamptzTyping', () => {
  it('flags a fabricated source file reproducing the mistyping bug class, using injected fakes', () => {
    const migrationsDir = '/fake/migrations';
    const srcDir = '/fake/src';
    const readdirImpl = (dir: string) => (dir === migrationsDir ? ['0001_x.sql'] : []);
    const walkImpl = (dir: string) => (dir === srcDir ? ['/fake/src/bad.ts', '/fake/src/good.ts'] : []);
    const readFileImpl = (path: string) => {
      if (path.endsWith('0001_x.sql')) {
        return `CREATE TABLE claim (\n  id uuid PRIMARY KEY,\n  opened_at timestamptz\n);`;
      }
      if (path.endsWith('bad.ts')) {
        return `client.query<{ opened_at: string }>(sql);`;
      }
      return `client.query<{ opened_at: Date }>(sql);`;
    };

    const results = checkAllTimestamptzTyping({ migrationsDir, srcDir, readdirImpl, readFileImpl, walkImpl });

    expect(results).toEqual([
      { file: '/fake/src/bad.ts', violations: [{ column: 'opened_at', declaredType: 'string' }] },
    ]);
  });

  it('the real repo has zero mistyped timestamptz columns across every current src/**/*.ts file', () => {
    // Integration-style: runs against this repo's actual migrations/ and
    // src/ on disk, not fakes -- proves the check is clean against real
    // current state (after this PR's set-claim-aging-deadline.ts fix).
    const results = checkAllTimestamptzTyping({
      migrationsDir: join(REPO_ROOT, 'migrations'),
      srcDir: join(REPO_ROOT, 'src'),
    });
    expect(results).toEqual([]);
  });
});
