import type PgBoss from 'pg-boss';
import { JOB_DEAD_LETTER_NAMES, JOB_NAMES, type JobName } from './contracts.js';

export const JOB_QUEUE_POLICIES: Record<JobName, PgBoss.Queue> = Object.fromEntries(
  Object.values(JOB_NAMES).map((name) => [name, {
    name,
    policy: 'standard' as const,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInMinutes: 15,
    retentionDays: 30,
    deadLetter: JOB_DEAD_LETTER_NAMES[name],
  }]),
) as Record<JobName, PgBoss.Queue>;

export async function registerJobQueues(boss: Pick<PgBoss, 'createQueue'>): Promise<void> {
  for (const deadLetterName of Object.values(JOB_DEAD_LETTER_NAMES)) {
    await boss.createQueue(deadLetterName, {
      name: deadLetterName,
      policy: 'standard',
      retentionDays: 90,
    });
  }
  for (const name of Object.values(JOB_NAMES)) {
    await boss.createQueue(name, JOB_QUEUE_POLICIES[name]);
  }
}
