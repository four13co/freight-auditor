import { describe, expect, it, vi } from 'vitest';
import { JOB_DEAD_LETTER_NAMES, JOB_NAMES } from '../../src/jobs/contracts.js';
import { JOB_QUEUE_POLICIES, registerJobQueues } from '../../src/jobs/policies.js';

describe('job retry and dead-letter policies', () => {
  it('defines bounded exponential retries and a versioned dead-letter target for every job', () => {
    for (const name of Object.values(JOB_NAMES)) {
      expect(JOB_QUEUE_POLICIES[name]).toMatchObject({
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 15,
        retentionDays: 30,
        deadLetter: JOB_DEAD_LETTER_NAMES[name],
      });
      expect(JOB_DEAD_LETTER_NAMES[name]).toMatch(/\.dead-letter\.v1$/);
    }
  });

  it('creates dead-letter queues before their source queues', async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    await registerJobQueues({ createQueue } as never);

    const names = createQueue.mock.calls.map(([name]) => name);
    const sourceCount = Object.values(JOB_NAMES).length;
    expect(names.slice(0, sourceCount)).toEqual(Object.values(JOB_DEAD_LETTER_NAMES));
    expect(names.slice(sourceCount)).toEqual(Object.values(JOB_NAMES));
  });
});
