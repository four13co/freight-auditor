#!/usr/bin/env node
// Static check for the recurring review finding (86e31c2kx): a test file's
// afterAll teardown deletes rows in the wrong FK order -- a parent table
// row deleted before its dependent child rows -- violating a foreign-key
// constraint. Hit four times (PRs #163, #167, #165, #199), each a one-off
// regression against a convention (see test/db/findings-endpoint.db.test.ts)
// that wasn't enforced anywhere.
//
// Derives the real parent -> child FK graph from migrations/*.sql (ground
// truth, not a hand-maintained list that can drift), then parses each
// test/db/*.db.test.ts file's afterAll block for `DELETE FROM <table>`
// statements in order. Flags any case where a table is deleted before a
// table that (per the FK graph) depends on it, when both are deleted in
// that same afterAll block -- exactly the shape all four incidents shared.
//
// Deliberately conservative: only DELETE FROM statements found textually
// inside an afterAll(...) callback are considered, and only tables that
// appear on BOTH sides of a real FK edge (both the table and its dependent
// are deleted in the same block) are checked -- a table deleted alone, or
// whose dependent isn't cleaned up in this file at all, is out of scope for
// this check (nothing to get the order wrong between).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INLINE_FK = /^\s*"?(\w+)"?\s+\w[\w()]*\s+(?:NOT NULL\s+)?REFERENCES\s+(\w+)\s*\(/gim;
const TABLE_FK = /FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(\w+)\s*\(/gim;
const CREATE_TABLE = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(/gim;

/**
 * Parses migrations/*.sql for CREATE TABLE blocks and builds a parent ->
 * Set<child> map from every REFERENCES found inside each table's own
 * definition (inline column FKs). The table-level `FOREIGN KEY (...)
 * REFERENCES` form found elsewhere in the same statement is also picked up
 * by re-scanning the full statement text, not just column lines.
 *
 * @param {string[]} sqlContents - the full text of every migration file, in any order (order doesn't matter: this reads structure, not applied history)
 * @returns {Map<string, Set<string>>} parentTable -> Set of childTable names that reference it
 */
export function buildForeignKeyGraph(sqlContents) {
  const parentToChildren = new Map();

  for (const sql of sqlContents) {
    // Split into individual `CREATE TABLE name ( ... );` statements by
    // tracking paren depth from each CREATE TABLE match to its closing `);`.
    CREATE_TABLE.lastIndex = 0;
    let match;
    while ((match = CREATE_TABLE.exec(sql))) {
      const childTable = match[1];
      const bodyStart = match.index + match[0].length;
      let depth = 1;
      let i = bodyStart;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') depth -= 1;
        i += 1;
      }
      const body = sql.slice(bodyStart, i);

      for (const re of [INLINE_FK, TABLE_FK]) {
        re.lastIndex = 0;
        let fkMatch;
        while ((fkMatch = re.exec(body))) {
          const parentTable = re === INLINE_FK ? fkMatch[2] : fkMatch[1];
          if (!parentToChildren.has(parentTable)) parentToChildren.set(parentTable, new Set());
          parentToChildren.get(parentTable).add(childTable);
        }
      }
    }
  }

  return parentToChildren;
}

/**
 * Extracts the sequence of `DELETE FROM <table>` targets found textually
 * inside a single afterAll(...) callback, in source order. Returns null if
 * the file has no afterAll block.
 *
 * @param {string} testFileContent
 * @returns {string[] | null}
 */
export function extractAfterAllDeleteOrder(testFileContent) {
  const afterAllStart = testFileContent.indexOf('afterAll(');
  if (afterAllStart === -1) return null;

  // Find the matching close of afterAll's outer function by paren-depth
  // scanning from its opening `(`.
  let depth = 0;
  let i = afterAllStart + 'afterAll'.length;
  let bodyStart = -1;
  for (; i < testFileContent.length; i += 1) {
    if (testFileContent[i] === '(') {
      depth += 1;
      if (bodyStart === -1) bodyStart = i;
    } else if (testFileContent[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = testFileContent.slice(bodyStart, i + 1);

  const deletes = [];
  const deleteRe = /DELETE FROM\s+"?(\w+)"?/gi;
  let m;
  while ((m = deleteRe.exec(body))) {
    deletes.push(m[1]);
  }
  return deletes;
}

/**
 * @param {string[]} deleteOrder - tables deleted in source order
 * @param {Map<string, Set<string>>} fkGraph - parentTable -> Set<childTable>
 * @returns {{ parent: string, child: string }[]} violations: parent deleted before a child that's also in deleteOrder
 */
export function findOrderViolations(deleteOrder, fkGraph) {
  const violations = [];
  const positionOf = new Map(deleteOrder.map((table, idx) => [table, idx]));

  for (const [parent, children] of fkGraph.entries()) {
    const parentPos = positionOf.get(parent);
    if (parentPos === undefined) continue;
    for (const child of children) {
      const childPos = positionOf.get(child);
      if (childPos === undefined) continue;
      if (parentPos < childPos) {
        violations.push({ parent, child });
      }
    }
  }

  return violations;
}

/**
 * @param {{ migrationsDir: string, testDbDir: string, readdirImpl?: typeof readdirSync, readFileImpl?: typeof readFileSync }} opts
 * @returns {{ file: string, violations: { parent: string, child: string }[] }[]} only files with at least one violation
 */
export function checkAllTeardowns({
  migrationsDir,
  testDbDir,
  readdirImpl = readdirSync,
  readFileImpl = (p) => readFileSync(p, 'utf8'),
}) {
  const migrationFiles = readdirImpl(migrationsDir).filter((f) => f.endsWith('.sql'));
  const sqlContents = migrationFiles.map((f) => readFileImpl(join(migrationsDir, f)));
  const fkGraph = buildForeignKeyGraph(sqlContents);

  const testFiles = readdirImpl(testDbDir).filter((f) => f.endsWith('.db.test.ts'));
  const results = [];
  for (const file of testFiles) {
    const content = readFileImpl(join(testDbDir, file));
    const deleteOrder = extractAfterAllDeleteOrder(content);
    if (!deleteOrder) continue;
    const violations = findOrderViolations(deleteOrder, fkGraph);
    if (violations.length > 0) results.push({ file, violations });
  }
  return results;
}

export async function main({
  migrationsDir = join(new URL('../migrations', import.meta.url).pathname),
  testDbDir = join(new URL('../test/db', import.meta.url).pathname),
  exit = process.exit,
  log = (msg) => process.stdout.write(`${msg}\n`),
  runImpl = checkAllTeardowns,
} = {}) {
  const results = runImpl({ migrationsDir, testDbDir });
  if (results.length === 0) {
    log('check-teardown-fk-order: no FK-order violations found in any test/db afterAll block');
    return;
  }
  log(`check-teardown-fk-order: found ${results.length} file(s) with FK-order violations:\n`);
  for (const { file, violations } of results) {
    log(`  ${file}:`);
    for (const { parent, child } of violations) {
      log(`    - deletes "${parent}" before "${child}", but "${child}" has a foreign key referencing "${parent}"`);
    }
  }
  log('\nFix: delete dependent (child) rows before their parent, matching the pattern in test/db/findings-endpoint.db.test.ts.');
  exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
