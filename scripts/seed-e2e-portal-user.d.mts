import type pg from 'pg';

export declare const E2E_PORTAL_EMAIL: string;
export declare const E2E_PORTAL_PASSWORD: string;

export interface SeedE2ePortalUserOptions {
  pool?: pg.Pool;
}

export declare function seedE2ePortalUser(options?: SeedE2ePortalUserOptions): Promise<void>;
