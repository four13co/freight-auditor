import type pg from 'pg';

export declare const E2E_PORTAL_ADMIN_EMAIL: string;
export declare const E2E_PORTAL_ADMIN_PASSWORD: string;

export interface SeedE2ePortalAdminUserOptions {
  pool?: pg.Pool;
}

export declare function seedE2ePortalAdminUser(options?: SeedE2ePortalAdminUserOptions): Promise<void>;
