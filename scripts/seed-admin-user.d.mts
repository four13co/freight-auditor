import type pg from 'pg';

export declare const ADMIN_EMAIL: string;

export interface SeedAdminUserOptions {
  pool?: pg.Pool;
  password?: string;
}

export declare function seedAdminUser(options?: SeedAdminUserOptions): Promise<void>;
