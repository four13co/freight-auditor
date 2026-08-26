import { describe, expect, it, vi } from 'vitest';
import { handleSftpPollJob, SftpConnectionUnavailableError } from '../../src/jobs/sftp-poll-handler.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const payload = {
  schemaVersion: 1 as const,
  clientId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: 'poll-2026-08-25T12:00Z',
  requestedAt: '2026-08-25T12:00:00.000Z',
};

describe(JOB_NAMES.POLL_SFTP_V1, () => {
  it('fails closed when the connection is missing or outside tenant scope', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(handleSftpPollJob(db as never, {} as never, {} as never, payload))
      .rejects.toBeInstanceOf(SftpConnectionUnavailableError);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('client_id = $2'), [payload.connectionId, payload.clientId]);
  });

  it('rejects malformed queue input before querying tenant data', async () => {
    const db = { query: vi.fn() };
    await expect(handleSftpPollJob(db as never, {} as never, {} as never, { ...payload, clientId: 'nope' }))
      .rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
