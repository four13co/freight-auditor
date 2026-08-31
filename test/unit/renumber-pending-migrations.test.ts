import { describe, it, expect, vi } from 'vitest';
import {
  listMigrationFiles,
  planRenumbering,
  renumberPendingMigrations,
} from '../../scripts/renumber-pending-migrations.mjs';

describe('listMigrationFiles', () => {
  it('parses leading numbers and sorts ascending', () => {
    const readdirImpl = () => ['0010_b.sql', '0002_a.sql', 'not-a-migration.txt', '0100_c.sql'];
    const files = listMigrationFiles('/fake/migrations', { readdirImpl });
    expect(files).toEqual([
      { number: '0002', file: '0002_a.sql' },
      { number: '0010', file: '0010_b.sql' },
      { number: '0100', file: '0100_c.sql' },
    ]);
  });
});

describe('planRenumbering', () => {
  it('reproduces the #212 incident: a pending file numbered below an already-applied file gets bumped above it', () => {
    // 0045 authored/merged before 0046 and 0050 were applied elsewhere, but
    // by the time this deploy runs, 0046 and 0050 are already in pgmigrations.
    const diskFiles = [
      { number: '0045', file: '0045_claim_dispute_unique.sql' },
      { number: '0046', file: '0046_workflow_instance.sql' },
      { number: '0050', file: '0050_claim_aging_deadline.sql' },
    ];
    const appliedNames = new Set(['0046_workflow_instance', '0050_claim_aging_deadline']);

    const plan = planRenumbering(diskFiles, appliedNames);

    expect(plan).toEqual([
      { from: '0045_claim_dispute_unique.sql', to: '0051_claim_dispute_unique.sql', digits: 4 },
    ]);
  });

  it('reproduces the #217 incident: multiple pending files below the applied high-water mark are renumbered in relative order', () => {
    const diskFiles = [
      { number: '0047', file: '0047_client_payment_policy.sql' },
      { number: '0048', file: '0048_unknown_charge_code_trigger.sql' },
      { number: '0055', file: '0055_claim_dispute_unique.sql' },
    ];
    const appliedNames = new Set(['0055_claim_dispute_unique']);

    const plan = planRenumbering(diskFiles, appliedNames);

    expect(plan).toEqual([
      { from: '0047_client_payment_policy.sql', to: '0056_client_payment_policy.sql', digits: 4 },
      { from: '0048_unknown_charge_code_trigger.sql', to: '0057_unknown_charge_code_trigger.sql', digits: 4 },
    ]);
  });

  it('does nothing when every pending file already numbers above the applied high-water mark', () => {
    const diskFiles = [
      { number: '0055', file: '0055_claim_dispute_unique.sql' },
      { number: '0058', file: '0058_client_payment_policy.sql' },
    ];
    const appliedNames = new Set(['0055_claim_dispute_unique']);

    expect(planRenumbering(diskFiles, appliedNames)).toEqual([]);
  });

  it('does nothing on an empty/fresh database with no applied history', () => {
    const diskFiles = [{ number: '0001', file: '0001_extensions_and_roles.sql' }];
    expect(planRenumbering(diskFiles, new Set())).toEqual([]);
  });

  it('never touches an already-applied file, even if a lower-numbered pending file needs to move past it', () => {
    const diskFiles = [
      { number: '0010', file: '0010_pending.sql' },
      { number: '0020', file: '0020_applied.sql' },
    ];
    const appliedNames = new Set(['0020_applied']);

    const plan = planRenumbering(diskFiles, appliedNames);

    expect(plan).toEqual([{ from: '0010_pending.sql', to: '0021_pending.sql', digits: 4 }]);
    expect(plan.some((p: { from: string }) => p.from === '0020_applied.sql')).toBe(false);
  });
});

describe('renumberPendingMigrations', () => {
  function fakeClient({
    rows = [] as { name: string }[],
    queryError = null as Error | null,
  } = {}) {
    return class FakeClient {
      async connect() {}
      async query() {
        if (queryError) throw queryError;
        return { rows };
      }
      async end() {}
    };
  }

  it('renames colliding pending files on disk via the injected rename function', async () => {
    const clientImpl = fakeClient({ rows: [{ name: '0055_claim_dispute_unique' }] });
    const renameImpl = vi.fn();
    const listImpl = () => [
      { number: '0047', file: '0047_client_payment_policy.sql' },
      { number: '0055', file: '0055_claim_dispute_unique.sql' },
    ];

    const plan = await renumberPendingMigrations({
      connectionString: 'postgresql://fake',
      migrationsDir: '/fake/migrations',
      clientImpl,
      renameImpl,
      listImpl,
      logInfo: () => {},
    });

    expect(plan).toEqual([
      { from: '0047_client_payment_policy.sql', to: '0056_client_payment_policy.sql', digits: 4 },
    ]);
    expect(renameImpl).toHaveBeenCalledWith('/fake/migrations/0047_client_payment_policy.sql', '/fake/migrations/0056_client_payment_policy.sql');
  });

  it('treats a missing pgmigrations table (brand-new DB) as empty applied history, not an error', async () => {
    const queryError = new Error('relation "public.pgmigrations" does not exist');
    const clientImpl = fakeClient({ queryError });
    const renameImpl = vi.fn();
    const listImpl = () => [{ number: '0001', file: '0001_extensions_and_roles.sql' }];

    const plan = await renumberPendingMigrations({
      connectionString: 'postgresql://fake',
      migrationsDir: '/fake/migrations',
      clientImpl,
      renameImpl,
      listImpl,
      logInfo: () => {},
    });

    expect(plan).toEqual([]);
    expect(renameImpl).not.toHaveBeenCalled();
  });

  it('propagates a genuine query error (not the missing-table case) rather than swallowing it', async () => {
    const queryError = new Error('connection refused');
    const clientImpl = fakeClient({ queryError });

    await expect(
      renumberPendingMigrations({
        connectionString: 'postgresql://fake',
        migrationsDir: '/fake/migrations',
        clientImpl,
        renameImpl: vi.fn(),
        listImpl: () => [],
        logInfo: () => {},
      }),
    ).rejects.toThrow('connection refused');
  });
});
