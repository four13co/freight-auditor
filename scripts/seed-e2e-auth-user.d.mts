import type pg from 'pg';

export declare const E2E_AUTH_EMAIL: string;
export declare const E2E_AUTH_PASSWORD: string;

export interface SeedE2eAuthUserOptions {
  pool?: pg.Pool;
}

export declare function seedE2eAuthUser(options?: SeedE2eAuthUserOptions): Promise<void>;
