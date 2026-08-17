import type pg from 'pg';

export declare const FIXTURE_INVOICE_NUMBER: string;
export declare const FIXTURE_CARRIER_NAME: string;
export declare const FIXTURE_CONTRACT_RATE: string;

export declare function assertVarianceFindingDerived(
  client: pg.PoolClient,
  auditRunId: string,
): Promise<void>;

export interface SeedFullstackE2eFixtureOptions {
  pool?: pg.Pool;
}

export declare function seedFullstackE2eFixture(options?: SeedFullstackE2eFixtureOptions): Promise<void>;
