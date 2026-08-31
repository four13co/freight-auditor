#!/usr/bin/env node
// Static check for the recurring review finding (86e31c2jy): the pg driver
// returns a timestamptz column as a JS Date object at runtime (no
// setTypeParser override exists anywhere in this repo -- confirmed against
// src/db/pool.ts), but a query result's generic row type sometimes claims
// that column is a `string`, masking a missing .toISOString() conversion
// from the type checker until it crashes or silently compares wrong at
// runtime (PRs #175, #179, #180; partially closed for the writeAuditEvent
// call path specifically by #193's schema-level coercion, but the
// underlying mistyping -- and its risk at every OTHER call site -- was
// never itself prevented).
//
// Derives the real set of timestamptz column names from migrations/*.sql
// (ground truth), then scans every `client.query<{ ... }>` inline generic
// in src/**/*.ts for a property whose name is a known timestamptz column
// but whose declared type is `string` (optionally `| null`) rather than
// `Date`. Deliberately narrow: only the inline-generic-on-query() shape is
// checked (the one every current call site in this repo uses), not every
// interface/type alias in the codebase -- a broader AST-based check would
// need a real TS type checker to avoid false positives on legitimately
// pre-stringified columns (e.g. a `::text`-cast SQL expression), which is
// out of scope for a fast, dependency-free grep-based guard.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TIMESTAMPTZ_COLUMN_DECL = /^\s*"?(\w+)"?\s+timestamptz\b/gim;
const QUERY_GENERIC = /client\.query<\{([^}]*)\}>/g;
const ROW_PROPERTY = /(\w+)\s*:\s*([^;,\n]+)/g;

/**
 * @param {string[]} sqlContents
 * @returns {Set<string>} every distinct column name declared `timestamptz` anywhere in the schema
 */
export function findTimestamptzColumns(sqlContents) {
  const columns = new Set();
  for (const sql of sqlContents) {
    TIMESTAMPTZ_COLUMN_DECL.lastIndex = 0;
    let m;
    while ((m = TIMESTAMPTZ_COLUMN_DECL.exec(sql))) {
      columns.add(m[1]);
    }
  }
  return columns;
}

/**
 * @param {string} typeText - the raw type text after the colon, e.g. "string", "string | null", "Date"
 * @returns {boolean} true if this type claims to be a string (with or without | null) and NOT a Date
 */
function claimsStringNotDate(typeText) {
  const trimmed = typeText.trim();
  if (/\bDate\b/.test(trimmed)) return false;
  return /\bstring\b/.test(trimmed);
}

/**
 * @param {string} fileContent
 * @param {Set<string>} timestamptzColumns
 * @returns {{ column: string, declaredType: string }[]}
 */
export function findMistypedColumns(fileContent, timestamptzColumns) {
  const violations = [];
  QUERY_GENERIC.lastIndex = 0;
  let genericMatch;
  while ((genericMatch = QUERY_GENERIC.exec(fileContent))) {
    const body = genericMatch[1];
    ROW_PROPERTY.lastIndex = 0;
    let propMatch;
    while ((propMatch = ROW_PROPERTY.exec(body))) {
      const [, name, typeText] = propMatch;
      if (timestamptzColumns.has(name) && claimsStringNotDate(typeText)) {
        violations.push({ column: name, declaredType: typeText.trim() });
      }
    }
  }
  return violations;
}

/**
 * Recursively lists every non-test .ts file under dir, using the real
 * filesystem (readdirSync with withFileTypes).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function walkTsFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * @param {{ migrationsDir: string, srcDir: string, readdirImpl?: (dir: string) => string[], readFileImpl?: (path: string) => string, walkImpl?: typeof walkTsFiles }} opts
 * @returns {{ file: string, violations: { column: string, declaredType: string }[] }[]}
 */
export function checkAllTimestamptzTyping({
  migrationsDir,
  srcDir,
  readdirImpl = readdirSync,
  readFileImpl = (p) => readFileSync(p, 'utf8'),
  walkImpl = walkTsFiles,
}) {
  const migrationFiles = readdirImpl(migrationsDir).filter((f) => f.endsWith('.sql'));
  const sqlContents = migrationFiles.map((f) => readFileImpl(join(migrationsDir, f)));
  const timestamptzColumns = findTimestamptzColumns(sqlContents);

  const results = [];
  for (const file of walkImpl(srcDir)) {
    const violations = findMistypedColumns(readFileImpl(file), timestamptzColumns);
    if (violations.length > 0) results.push({ file, violations });
  }

  return results;
}

export async function main({
  migrationsDir = join(new URL('../migrations', import.meta.url).pathname),
  srcDir = join(new URL('../src', import.meta.url).pathname),
  exit = process.exit,
  log = (msg) => process.stdout.write(`${msg}\n`),
  runImpl = checkAllTimestamptzTyping,
} = {}) {
  const results = runImpl({ migrationsDir, srcDir });
  if (results.length === 0) {
    log('check-timestamptz-typing: no timestamptz columns mistyped as string in any client.query<{...}> generic');
    return;
  }
  log(`check-timestamptz-typing: found ${results.length} file(s) with mistyped timestamptz columns:\n`);
  for (const { file, violations } of results) {
    log(`  ${file}:`);
    for (const { column, declaredType } of violations) {
      log(`    - "${column}" is declared \`${declaredType}\`, but pg returns timestamptz columns as Date (no setTypeParser override exists)`);
    }
  }
  log('\nFix: type the column as Date, and call .toISOString() explicitly wherever a string is actually needed.');
  exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
