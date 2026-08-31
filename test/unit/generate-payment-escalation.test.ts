import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import {
  generatePaymentEscalation,
  GeneratePaymentEscalationError,
} from '../../src/modules/payments/generate-payment-escalation.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const auditRunId = '20000000-0000-4000-8000-000000000002';

function mockClient(opts: {
  holdRecordedAt?: Date;
  hasApprove?: boolean;
  inserted?: boolean;
}) {
  const query = vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes(`action = 'hold'`)) {
      return opts.holdRecordedAt ? { rows: [{ recorded_at: opts.holdRecordedAt }] } : { rows: [] };
    }
    if (sql.includes(`action = 'approve'`)) {
      return opts.hasApprove ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO audit_event')) {
      const created = opts.inserted ?? true;
      return { rows: [{ id: (values as unknown[])[0], created }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as PoolClient;
}

describe('generatePaymentEscalation', () => {
  it('throws NO_HOLD_DECISION when no hold decision exists for the run', async () => {
    const client = mockClient({});
    await expect(generatePaymentEscalation(client, clientId, auditRunId))
      .rejects.toBeInstanceOf(GeneratePaymentEscalationError);
    await expect(generatePaymentEscalation(client, clientId, auditRunId))
      .rejects.toMatchObject({ code: 'NO_HOLD_DECISION' });
  });

  it('throws ALREADY_APPROVED when an approve decision already exists for the run', async () => {
    const client = mockClient({ holdRecordedAt: new Date('2026-08-01T00:00:00.000Z'), hasApprove: true });
    await expect(generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-20T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'ALREADY_APPROVED' });
  });

  it('throws GRACE_PERIOD_NOT_ELAPSED when the hold is too recent', async () => {
    const client = mockClient({ holdRecordedAt: new Date('2026-08-20T00:00:00.000Z') });
    await expect(generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-22T00:00:00.000Z')))
      .rejects.toMatchObject({ code: 'GRACE_PERIOD_NOT_ELAPSED' });
  });

  it('writes an escalation audit event with an ISO-string hold timestamp once the grace period elapses', async () => {
    const holdRecordedAt = new Date('2026-08-01T00:00:00.000Z');
    const client = mockClient({ holdRecordedAt, inserted: true });
    const result = await generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-10T00:00:00.000Z'));
    expect(result.created).toBe(true);
    expect(result.auditRunId).toBe(auditRunId);
    const auditCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeDefined();
    const [, values] = auditCall as [string, unknown[]];
    expect(values[4]).toBe('payment_gate.escalated');
    expect(values[9]).toEqual({ auditRunId, holdRecordedAt: '2026-08-01T00:00:00.000Z', gracePeriodDays: 7 });
  });

  it('is idempotent: a second call after the event already exists returns created: false', async () => {
    const client = mockClient({ holdRecordedAt: new Date('2026-08-01T00:00:00.000Z'), inserted: false });
    const result = await generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-10T00:00:00.000Z'));
    expect(result.created).toBe(false);
  });

  it('defaults the grace period to 7 days', async () => {
    const client = mockClient({ holdRecordedAt: new Date('2026-08-01T00:00:00.000Z') });
    await expect(generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-07T12:00:00.000Z')))
      .rejects.toMatchObject({ code: 'GRACE_PERIOD_NOT_ELAPSED' });
    await expect(generatePaymentEscalation(client, clientId, auditRunId, new Date('2026-08-08T00:00:01.000Z')))
      .resolves.toMatchObject({ created: true });
  });
});
