import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildForeignKeyGraph,
  extractAfterAllDeleteOrder,
  findOrderViolations,
  checkAllTeardowns,
} from '../../scripts/check-teardown-fk-order.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

describe('buildForeignKeyGraph', () => {
  it('extracts an inline column REFERENCES edge', () => {
    const sql = `
      CREATE TABLE client (
        id uuid PRIMARY KEY
      );
      CREATE TABLE audit_run (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES client(id)
      );
    `;
    const graph = buildForeignKeyGraph([sql]);
    expect(graph.get('client')).toEqual(new Set(['audit_run']));
  });

  it('extracts a table-level FOREIGN KEY (...) REFERENCES edge', () => {
    const sql = `
      CREATE TABLE promotion_event (
        id uuid PRIMARY KEY,
        backtest_run_id uuid,
        FOREIGN KEY (backtest_run_id) REFERENCES audit_run(id)
      );
    `;
    const graph = buildForeignKeyGraph([sql]);
    expect(graph.get('audit_run')).toEqual(new Set(['promotion_event']));
  });

  it('accumulates multiple children of the same parent across files', () => {
    const sqlA = `
      CREATE TABLE variance_finding (
        id uuid PRIMARY KEY,
        audit_run_id uuid REFERENCES audit_run(id)
      );
    `;
    const sqlB = `
      CREATE TABLE audit_event (
        id uuid PRIMARY KEY,
        audit_run_id uuid REFERENCES audit_run(id)
      );
    `;
    const graph = buildForeignKeyGraph([sqlA, sqlB]);
    expect(graph.get('audit_run')).toEqual(new Set(['variance_finding', 'audit_event']));
  });
});

describe('extractAfterAllDeleteOrder', () => {
  it('returns DELETE FROM targets in source order from the afterAll block', () => {
    const content = `
      describe('x', () => {
        beforeAll(async () => { /* setup */ });
        afterAll(async () => {
          await owner.query(\`DELETE FROM variance_finding WHERE client_id = $1\`, [clientId]);
          await owner.query(\`DELETE FROM audit_run WHERE client_id = $1\`, [clientId]);
        });
      });
    `;
    expect(extractAfterAllDeleteOrder(content)).toEqual(['variance_finding', 'audit_run']);
  });

  it('returns null when there is no afterAll block', () => {
    expect(extractAfterAllDeleteOrder(`describe('x', () => { it('y', () => {}); });`)).toBeNull();
  });

  it('ignores DELETE FROM statements outside the afterAll block', () => {
    const content = `
      beforeEach(async () => { await q(\`DELETE FROM scratch\`); });
      afterAll(async () => {
        await q(\`DELETE FROM audit_run WHERE client_id = $1\`, [clientId]);
      });
    `;
    expect(extractAfterAllDeleteOrder(content)).toEqual(['audit_run']);
  });
});

describe('findOrderViolations', () => {
  it('reproduces PR #163: audit_run deleted before variance_finding, which references it', () => {
    const fkGraph = new Map([['audit_run', new Set(['variance_finding'])]]);
    const deleteOrder = ['audit_run', 'variance_finding'];
    expect(findOrderViolations(deleteOrder, fkGraph)).toEqual([{ parent: 'audit_run', child: 'variance_finding' }]);
  });

  it('reproduces PR #165/#199: client deleted before audit_event, which references it', () => {
    const fkGraph = new Map([['client', new Set(['audit_event'])]]);
    const deleteOrder = ['audit_event_replay_manifest', 'client', 'audit_event'];
    expect(findOrderViolations(deleteOrder, fkGraph)).toEqual([{ parent: 'client', child: 'audit_event' }]);
  });

  it('is clean when the child is deleted before its parent', () => {
    const fkGraph = new Map([['audit_run', new Set(['variance_finding'])]]);
    const deleteOrder = ['variance_finding', 'audit_run'];
    expect(findOrderViolations(deleteOrder, fkGraph)).toEqual([]);
  });

  it('does not flag a parent whose dependent is not deleted in this block at all', () => {
    const fkGraph = new Map([['client', new Set(['audit_event'])]]);
    const deleteOrder = ['client']; // audit_event never appears -- nothing to get wrong here
    expect(findOrderViolations(deleteOrder, fkGraph)).toEqual([]);
  });
});

describe('checkAllTeardowns', () => {
  it('flags a fabricated test file reproducing the FK-order bug class, using injected fakes', () => {
    const migrationsDir = '/fake/migrations';
    const testDbDir = '/fake/test/db';
    const readdirImpl = (dir: string) =>
      dir === migrationsDir ? ['0001_x.sql'] : ['bad.db.test.ts', 'good.db.test.ts'];
    const readFileImpl = (path: string) => {
      if (path.endsWith('0001_x.sql')) {
        return `
          CREATE TABLE audit_run (
            id uuid PRIMARY KEY
          );
          CREATE TABLE variance_finding (
            id uuid PRIMARY KEY,
            audit_run_id uuid REFERENCES audit_run(id)
          );
        `;
      }
      if (path.endsWith('bad.db.test.ts')) {
        return `afterAll(async () => {
          await q(\`DELETE FROM audit_run WHERE id = $1\`, [id]);
          await q(\`DELETE FROM variance_finding WHERE id = $1\`, [id]);
        });`;
      }
      // good.db.test.ts: correct order
      return `afterAll(async () => {
        await q(\`DELETE FROM variance_finding WHERE id = $1\`, [id]);
        await q(\`DELETE FROM audit_run WHERE id = $1\`, [id]);
      });`;
    };

    const results = checkAllTeardowns({ migrationsDir, testDbDir, readdirImpl, readFileImpl });

    expect(results).toEqual([
      { file: 'bad.db.test.ts', violations: [{ parent: 'audit_run', child: 'variance_finding' }] },
    ]);
  });

  it('the real repo has zero FK-order violations across every current test/db/*.db.test.ts file', () => {
    // Integration-style: runs against this repo's actual migrations/ and
    // test/db/ on disk, not fakes -- proves the check is clean against real
    // current state, and would have caught all four historical incidents
    // had it existed when their PRs were open.
    const results = checkAllTeardowns({
      migrationsDir: join(REPO_ROOT, 'migrations'),
      testDbDir: join(REPO_ROOT, 'test/db'),
      readdirImpl: readdirSync,
      readFileImpl: (p) => readFileSync(p, 'utf8'),
    });
    expect(results).toEqual([]);
  });
});
