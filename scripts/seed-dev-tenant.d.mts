import type pg from 'pg';

export declare const DEV_CLIENT_ID: string;
export declare const DEV_USER_ID: string;

export interface SeedDevTenantOptions {
  pool?: pg.Pool;
}

export declare function seedDevTenant(options?: SeedDevTenantOptions): Promise<void>;
