import { getPool, closePool } from '../../src/db/pool.js';
import { seedCriteria } from '../../scripts/seed-criteria.mjs';

/**
 * DB tests exercise production finding constraints, so every suite starts
 * with the same canonical criterion/rule reference data as a deployment.
 */
export async function setup(): Promise<void> {
  await seedCriteria({ client: getPool() });
  await closePool();
}
