import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listClaimsDueForEscalation, listClaimsDueForFollowUp } from '../../src/modules/claims/list-claim-aging-queues.js';

// NOT RUNNABLE until #178 (claim.aging_deadline_at, migration 0050) merges
// to Development -- that column does not exist on the base this PR
// branches from (confirmed: `git ls-tree origin/Development --
// migrations/0050_claim_aging_deadline.sql` is empty). Same disclosure
// pattern as #184's generate-claim-follow-up.db.test.ts, which depends on
// the same column. Unit tests in test/unit/list-claim-aging-queues.test.ts
// are this round's real proof.
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('claim aging/follow-up/escalation queues (database)', () => {
  const clientId = randomUUID();

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Claim Queues Co', $2)`,
      [clientId, `claim-queues-${clientId}`],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedClaim(clientIdArg: string, agingDeadlineAt: string | null): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at, aging_deadline_at)
       VALUES ($1, '500.0000', 'USD', 'open', now(), $2) RETURNING id`,
      [clientIdArg, agingDeadlineAt],
    );
    return rows[0]!.id;
  }

  async function writeTerminalEvent(clientIdArg: string, claimId: string, event: string, recordedAt: string) {
    await getPool().query(
      `INSERT INTO audit_event (id, client_id, entity, entity_id, event, actor_kind, recorded_at)
       VALUES (gen_random_uuid(), $1, 'claim', $2, $3, 'system', $4)`,
      [clientIdArg, claimId, event, recordedAt],
    );
  }

  it('lists a claim past its aging deadline with no follow-up sent yet', async () => {
    const claimId = await seedClaim(clientId, '2020-01-01T00:00:00Z');

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClaimsDueForFollowUp(client, { clientId }));

    expect(result.some((r) => r.claimId === claimId)).toBe(true);
  });

  it('excludes a claim that already has a claim.follow_up_sent event', async () => {
    const claimId = await seedClaim(clientId, '2020-01-01T00:00:00Z');
    await writeTerminalEvent(clientId, claimId, 'claim.follow_up_sent', new Date().toISOString());

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClaimsDueForFollowUp(client, { clientId }));

    expect(result.some((r) => r.claimId === claimId)).toBe(false);
  });

  it('excludes a terminal claim from the follow-up queue', async () => {
    const claimId = await seedClaim(clientId, '2020-01-01T00:00:00Z');
    await writeTerminalEvent(clientId, claimId, 'claim.recovered', new Date().toISOString());

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClaimsDueForFollowUp(client, { clientId }));

    expect(result.some((r) => r.claimId === claimId)).toBe(false);
  });

  it('lists a claim whose follow-up grace period has elapsed for escalation', async () => {
    const claimId = await seedClaim(clientId, '2020-01-01T00:00:00Z');
    const oldFollowUp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeTerminalEvent(clientId, claimId, 'claim.follow_up_sent', oldFollowUp);

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClaimsDueForEscalation(client, { clientId }));

    expect(result.some((r) => r.claimId === claimId)).toBe(true);
  });

  it('excludes a claim whose follow-up grace period has not yet elapsed', async () => {
    const claimId = await seedClaim(clientId, '2020-01-01T00:00:00Z');
    await writeTerminalEvent(clientId, claimId, 'claim.follow_up_sent', new Date().toISOString());

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClaimsDueForEscalation(client, { clientId }));

    expect(result.some((r) => r.claimId === claimId)).toBe(false);
  });
});
