import { describe, expect, it, vi } from 'vitest';
import { grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';

describe('grantJobSchemaAccessToAppRole', () => {
  it('grants schema usage, table privileges, and default privileges to the app role', async () => {
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const boss = { getDb: () => ({ executeSql }) };

    await grantJobSchemaAccessToAppRole(boss);

    const statements = executeSql.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql: string) => /GRANT USAGE ON SCHEMA pgboss TO freight_app/.test(sql))).toBe(true);
    expect(statements.some((sql: string) => /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO freight_app/.test(sql))).toBe(true);
    expect(statements.some((sql: string) => /ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO freight_app/.test(sql))).toBe(true);
  });
});
