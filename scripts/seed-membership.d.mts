import type pg from 'pg';

export declare function upsertAnalystMembership(
  client: pg.PoolClient | pg.Pool,
  params: { userId: string; clientId: string },
): Promise<void>;
