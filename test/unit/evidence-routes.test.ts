import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';

describe('evidence routes', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  it.each([
    '/api/findings/not-a-uuid/provenance', '/api/audit-runs/not-a-uuid/rubric-snapshot',
    '/api/audit-runs/not-a-uuid/conflicts', '/api/audit-runs/not-a-uuid/replay-manifest',
  ])('requires authentication before evidence lookup: %s', async (url) => {
    const app = buildApp(); apps.push(app);
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });
});
