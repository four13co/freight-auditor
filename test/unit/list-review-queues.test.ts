import { describe, expect, it, vi } from 'vitest';
import { listReviewQueues } from '../../src/modules/findings/list-review-queues.js';

describe('listReviewQueues', () => {
  it('places dual-qualified rows in both canonical queues', async () => {
    const row = { id: 'f', audit_run_id: 'r', invoice_number: 'INV', criterion_key: 'RATE', created_at: new Date(), classification: 'unassessable', status: 'in_review' };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const result = await listReviewQueues({ query } as never);
    expect(result.escalation).toHaveLength(1);
    expect(result.unassessable).toHaveLength(1);
  });
});
