import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { selectRubricVersion } from '../../src/modules/rubric-resolver/select-rubric-version.js';

describe('bitemporal rubric-version selection (DB)', () => {
  let pool: pg.Pool;
  let rubricId: string;
  let originalId: string;
  let correctionId: string;

  beforeAll(async () => {
    pool = getPool();
    rubricId = (await pool.query(`INSERT INTO rubric (tier) VALUES ('STANDARD') RETURNING id`)).rows[0].id;
    originalId = (await pool.query(
      `INSERT INTO rubric_version (rubric_id, valid_from, valid_to, recorded_at)
       VALUES ($1, '2026-01-01', NULL, '2026-02-01T00:00:00Z') RETURNING id`, [rubricId],
    )).rows[0].id;
    correctionId = (await pool.query(
      `INSERT INTO rubric_version (rubric_id, valid_from, valid_to, recorded_at)
       VALUES ($1, '2026-01-01', NULL, '2026-08-01T00:00:00Z') RETURNING id`, [rubricId],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM rubric_version WHERE rubric_id = $1`, [rubricId]);
    await pool.query(`DELETE FROM rubric WHERE id = $1`, [rubricId]);
    await closePool();
  });

  it('replays the version known at an earlier system-time cutoff', async () => {
    await expect(selectRubricVersion(pool as never, {
      rubricId, effectiveOn: '2026-07-01', recordedAsOf: '2026-07-15T00:00:00Z',
    })).resolves.toMatchObject({ status: 'FOUND', version: { id: originalId } });
  });

  it('selects the later-recorded correction at a later cutoff deterministically', async () => {
    await expect(selectRubricVersion(pool as never, {
      rubricId, effectiveOn: '2026-07-01', recordedAsOf: '2026-08-15T00:00:00Z',
    })).resolves.toMatchObject({ status: 'FOUND', version: { id: correctionId } });
  });
});
