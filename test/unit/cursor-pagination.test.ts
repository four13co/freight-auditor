import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, paginateKeyset } from '../../src/shared/cursor-pagination.js';

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
