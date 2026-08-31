#!/usr/bin/env node
// Assigns the real migration number at deploy time (right before `migrate up`
// runs), not at authoring/merge time -- closing the gap that caused #212 and
// #217: an author reserves a number from the on-disk file list + open PRs,
// but two branches can both claim numbers below whatever a third, faster-
// merging branch already got applied to the live DB. node-pg-migrate's
// checkOrder then refuses to run the lower-numbered file at all (86e319zzf),
// requiring a reactive rename-and-re-PR cycle after the fact (86e31e6vz).
//
// This script queries the live `pgmigrations` table (the one place "safe"
// can actually be verified) for the highest currently-applied number, then
// renumbers any on-disk migration file that is NOT YET recorded there and
// whose number is <= that highest-applied number, reassigning it to
// (highest-applied + 1), (highest-applied + 2), ... in existing relative
// order. A pending file already numbered above the highest-applied number
// is left untouched. Idempotent and safe to run on every deploy: an already-
// applied file is never touched (its name matches what's in pgmigrations),
// and re-running against an unchanged DB/disk state is a no-op.

import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

/**
 * @param {string} migrationsDir
 * @returns {{ number: string, file: string }[]} sorted by numeric number ascending
 */
export function listMigrationFiles(migrationsDir, { readdirImpl = readdirSync } = {}) {
  const files = readdirImpl(migrationsDir).filter((f) => f.endsWith('.sql'));
  const parsed = [];
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    parsed.push({ number: match[1], file });
  }
  parsed.sort((a, b) => Number(a.number) - Number(b.number));
  return parsed;
}

/**
 * Pure planning function: given the on-disk file list and the set of names
 * already recorded as applied, decide which pending files need renumbering
 * and what their new numbers should be. No I/O -- fully unit-testable.
 *
 * @param {{ number: string, file: string }[]} diskFiles - ascending by number
 * @param {Set<string>} appliedNames - migration names (without .sql) recorded in pgmigrations
 * @returns {{ from: string, to: string, digits: number }[]} rename plan, old filename -> new filename
 */
export function planRenumbering(diskFiles, appliedNames) {
  const appliedNumbers = diskFiles
    .filter((f) => appliedNames.has(f.file.replace(/\.sql$/, '')))
    .map((f) => Number(f.number));
  const highestApplied = appliedNumbers.length > 0 ? Math.max(...appliedNumbers) : 0;

  const pending = diskFiles.filter((f) => !appliedNames.has(f.file.replace(/\.sql$/, '')));
  const collidingPending = pending.filter((f) => Number(f.number) <= highestApplied);
  if (collidingPending.length === 0) return [];

  // Preserve on-disk relative order among the colliding files, and use the
  // same zero-padded digit width as the file being renamed (this repo pads
  // to 4 digits today, but deriving it per-file keeps the plan correct if
  // that ever changes rather than hardcoding 4).
  const plan = [];
  let next = highestApplied + 1;
  for (const f of collidingPending) {
    const digits = f.number.length;
    const newNumber = String(next).padStart(digits, '0');
    const rest = f.file.slice(f.number.length);
    plan.push({ from: f.file, to: `${newNumber}${rest}`, digits });
    next += 1;
  }
  return plan;
}

/**
 * @param {{ connectionString: string, migrationsDir: string, clientImpl?: typeof Client, renameImpl?: typeof renameSync, listImpl?: typeof listMigrationFiles, logInfo?: (msg: string) => void }} opts
 */
export async function renumberPendingMigrations({
  connectionString,
  migrationsDir,
  clientImpl = Client,
  renameImpl = renameSync,
  listImpl = listMigrationFiles,
  logInfo = (msg) => process.stdout.write(`${msg}\n`),
}) {
  const client = new clientImpl({ connectionString });
  await client.connect();
  let appliedNames;
  try {
    const result = await client.query(
      `SELECT name FROM pgmigrations`.replace('pgmigrations', 'public.pgmigrations'),
    );
    appliedNames = new Set(result.rows.map((r) => r.name));
  } catch (err) {
    // pgmigrations doesn't exist yet on a brand-new DB (first-ever deploy) --
    // nothing is applied, so nothing on disk can collide. Treat as empty.
    if (err && /relation .*pgmigrations.* does not exist/i.test(String(err.message))) {
      appliedNames = new Set();
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }

  const diskFiles = listImpl(migrationsDir);
  const plan = planRenumbering(diskFiles, appliedNames);

  for (const { from, to } of plan) {
    logInfo(`renumber-pending-migrations: ${from} -> ${to} (pending file collided with already-applied history)`);
    renameImpl(join(migrationsDir, from), join(migrationsDir, to));
  }

  if (plan.length === 0) {
    logInfo('renumber-pending-migrations: no pending migration collides with applied history, nothing to do');
  }

  return plan;
}

export async function main({
  env = process.env,
  migrationsDir = join(new URL('../migrations', import.meta.url).pathname),
  exit = process.exit,
  runImpl = renumberPendingMigrations,
} = {}) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('renumber-pending-migrations: DATABASE_URL is not set\n');
    exit(1);
    return;
  }
  try {
    await runImpl({ connectionString, migrationsDir });
  } catch (err) {
    process.stderr.write(`renumber-pending-migrations: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
