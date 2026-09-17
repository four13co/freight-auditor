import type pg from 'pg';

export declare const MANY_TENANTS_COUNT: number;

export declare function manyTenantSlug(i: number): string;
export declare function manyTenantMemberEmail(i: number): string;

export interface SeedManyTenantMembersOptions {
  pool?: pg.Pool;
}

export declare function seedManyTenantMembers(options?: SeedManyTenantMembersOptions): Promise<void>;
