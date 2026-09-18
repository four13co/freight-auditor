import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  paginateKeyset,
  buildKeysetAnchorFrom,
  buildKeysetTieBreak,
  buildLimitOffsetClause,
} from '../../src/shared/cursor-pagination.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor', () => {
    const cursor = { v: '2026-01-01T00:00:00.000Z', id: '10000000-0000-4000-8000-000000000001' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects non-base64url/non-JSON garbage', () => {
    expect(decodeCursor('not-a-cursor!!!')).toBeNull();
  });

  it('rejects a cursor whose v is not a valid date', () => {
    const raw = Buffer.from(JSON.stringify({ v: 'not-a-date', id: '10000000-0000-4000-8000-000000000001' }), 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toBeNull();
  });

  it('rejects a cursor whose id is not a well-formed UUID', () => {
    const raw = Buffer.from(JSON.stringify({ v: '2026-01-01T00:00:00.000Z', id: 'not-a-uuid' }), 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toBeNull();
  });

  it('rejects a cursor missing a field', () => {
    const raw = Buffer.from(JSON.stringify({ v: '2026-01-01T00:00:00.000Z' }), 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toBeNull();
  });

  it('rejects a cursor that decodes to a non-object', () => {
    const raw = Buffer.from(JSON.stringify('just a string'), 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe('paginateKeyset', () => {
  const keyOf = (r: { v: string; id: string }) => r;

  it('returns all rows with nextCursor null when fewer rows than limit come back', () => {
    const rows = [{ v: '2026-01-01T00:00:00.000Z', id: '1' }];
    const result = paginateKeyset(rows, 50, keyOf);
    expect(result.page).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it('returns all rows with nextCursor null when rows.length === limit exactly (no overflow row)', () => {
    const rows = [
      { v: '2026-01-02T00:00:00.000Z', id: '2' },
      { v: '2026-01-01T00:00:00.000Z', id: '1' },
    ];
    const result = paginateKeyset(rows, 2, keyOf);
    expect(result.page).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it('trims the overflow row and derives nextCursor from the last kept row', () => {
    const rows = [
      { v: '2026-01-03T00:00:00.000Z', id: '3' },
      { v: '2026-01-02T00:00:00.000Z', id: '2' },
      { v: '2026-01-01T00:00:00.000Z', id: '1' },
    ];
    const result = paginateKeyset(rows, 2, keyOf);
    expect(result.page).toEqual(rows.slice(0, 2));
    // encodeCursor round-trip, not decodeCursor -- decodeCursor additionally
    // requires a well-formed UUID id, which is a route/HTTP-boundary
    // concern (real callers always have one); paginateKeyset itself is
    // agnostic to id shape.
    expect(result.nextCursor).toBe(encodeCursor({ v: '2026-01-02T00:00:00.000Z', id: '2' }));
  });
});

describe('buildKeysetAnchorFrom', () => {
  it('appends the cursor id as a new param and builds the correlated-subquery FROM addition', () => {
    const params: unknown[] = ['client-1'];
    const result = buildKeysetAnchorFrom(params, { table: 'claim', tsColumn: 'opened_at', cursorId: 'c5' });
    expect(params).toEqual(['client-1', 'c5']);
    expect(result.anchorTsAlias).toBe('anchor_opened_at');
    expect(result.fromClauseAddition).toMatch(
      /,\s*\(\s*SELECT opened_at AS anchor_opened_at, id AS anchor_id\s*FROM claim AS cursor_row\s*WHERE cursor_row\.id = \$2\s*\) cursor_anchor/,
    );
  });

  it('ANDs in an extra anchor predicate for a caller that must scope the anchor row explicitly', () => {
    const params: unknown[] = ['client-1'];
    const result = buildKeysetAnchorFrom(params, {
      table: 'claim',
      tsColumn: 'opened_at',
      cursorId: 'c5',
      extraAnchorPredicate: 'cursor_row.account_id = $1',
    });
    expect(result.fromClauseAddition).toMatch(/WHERE cursor_row\.id = \$2 AND cursor_row\.account_id = \$1/);
  });

  it('uses a column-specific anchor alias so two different sort columns never collide', () => {
    const params: unknown[] = [];
    const result = buildKeysetAnchorFrom(params, { table: 'gate_failure', tsColumn: 'recorded_at', cursorId: 'gf5' });
    expect(result.anchorTsAlias).toBe('anchor_recorded_at');
    expect(result.fromClauseAddition).toMatch(/SELECT recorded_at AS anchor_recorded_at, id AS anchor_id/);
  });
});

describe('buildKeysetTieBreak', () => {
  it('builds an unqualified tie-break condition when given bare column refs', () => {
    expect(buildKeysetTieBreak('opened_at', 'id', 'anchor_opened_at')).toBe(
      '(opened_at < cursor_anchor.anchor_opened_at OR (opened_at = cursor_anchor.anchor_opened_at AND id > cursor_anchor.anchor_id))',
    );
  });

  it('builds a table-qualified tie-break condition when given qualified column refs', () => {
    expect(buildKeysetTieBreak('gate_failure.recorded_at', 'gate_failure.id', 'anchor_recorded_at')).toBe(
      '(gate_failure.recorded_at < cursor_anchor.anchor_recorded_at OR (gate_failure.recorded_at = cursor_anchor.anchor_recorded_at AND gate_failure.id > cursor_anchor.anchor_id))',
    );
  });
});

describe('buildLimitOffsetClause', () => {
  it('appends limit and offset (defaulting offset to 0) and returns a LIMIT..OFFSET clause when there is no cursor', () => {
    const params: unknown[] = ['client-1'];
    const clause = buildLimitOffsetClause(params, { limit: 50, hasCursor: false });
    expect(params).toEqual(['client-1', 50, 0]);
    expect(clause).toBe('LIMIT $2 OFFSET $3');
  });

  it('honors an explicit offset', () => {
    const params: unknown[] = [];
    const clause = buildLimitOffsetClause(params, { limit: 10, offset: 20, hasCursor: false });
    expect(params).toEqual([10, 20]);
    expect(clause).toBe('LIMIT $1 OFFSET $2');
  });

  it('appends only limit and returns a bare LIMIT clause when a cursor is present', () => {
    const params: unknown[] = ['c5'];
    const clause = buildLimitOffsetClause(params, { limit: 10, hasCursor: true });
    expect(params).toEqual(['c5', 10]);
    expect(clause).toBe('LIMIT $2');
  });
});
