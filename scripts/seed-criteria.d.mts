import type pg from 'pg';

export interface SeedCriteriaOptions {
  client?: pg.Pool | pg.PoolClient;
}

export declare function seedCriteria(options?: SeedCriteriaOptions): Promise<void>;

export interface ResolvedCriterionIds {
  criterionId: string;
  ruleVersionId: string;
}

export declare function resolveCriterionIds(
  client: pg.Pool | pg.PoolClient,
  criterionKey: string,
): Promise<ResolvedCriterionIds | null>;
