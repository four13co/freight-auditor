import type { APIRequestContext, APIResponse } from '@playwright/test';
import type pg from 'pg';

interface SeedCheck {
  check: () => Promise<APIResponse>;
  errorHint: string;
  validate?: (response: APIResponse) => boolean | Promise<boolean>;
}

export async function assertSeeded(_request: APIRequestContext, check: SeedCheck): Promise<void> {
  const response = await check.check();
  const valid = response.ok() && (check.validate ? await check.validate(response) : true);
  if (!valid) {
    throw new Error(`Full-stack e2e setup check failed (HTTP ${response.status()}). ${check.errorHint}`);
  }
}

/**
 * 86e367r91: sibling to assertSeeded() above for the other recurring
 * seed-prerequisite shape -- a direct DB-lookup-then-throw, rather than an
 * HTTP check, guarding a fixture row (contract_version, carrier, ...) that
 * npm run seed:e2e-fullstack-fixture is expected to have already created.
 * Takes the caller's exact error message (not a template) so each spec's
 * own wording -- which file, which lookup, which seed script to blame -- is
 * unchanged from before this helper existed.
 */
export async function assertSeededRow<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  params: unknown[],
  errorMessage: string,
): Promise<T> {
  const result = await pool.query<T>(sql, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error(errorMessage);
  }
  return row;
}
