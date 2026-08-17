import type pg from 'pg';

export interface SeedCriteriaOptions {
  client?: pg.Pool | pg.PoolClient;
}

export declare function seedCriteria(options?: SeedCriteriaOptions): Promise<void>;

// 86e2v88u2: resolveCriterionIds itself now lives in
// src/modules/evaluator/resolve-criterion-ids.ts; re-exported here (matching
// this script's own runtime re-export) so existing .mjs-import callers keep
// working without a source change.
export type { ResolvedCriterionIds } from '../src/modules/evaluator/resolve-criterion-ids.js';
export { resolveCriterionIds } from '../src/modules/evaluator/resolve-criterion-ids.js';
