import { isUuid } from './request-validation.js';

/**
 * Opaque keyset cursor for the high-volume list APIs (P6.C.1): the sort
 * column's value (`v`, ISO 8601) plus the row's `id` as a tiebreaker, so a
 * cursor always resolves to a total order even when many rows share the
 * same sort-column value.
 */
export interface KeysetCursor {
  v: string;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a client-supplied cursor. Returns null (never
 * throws) on anything malformed -- base64/JSON garbage, a non-ISO `v`, a
 * non-UUID `id` -- so the route can turn a bad cursor into a 400 the same
 * way it already does for an out-of-range limit/offset, rather than a 500
 * from an unhandled parse error.
 */
export function decodeCursor(raw: string): KeysetCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, id } = parsed as Record<string, unknown>;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return null;
  if (typeof id !== 'string' || !isUuid(id)) return null;
  return { v, id };
}

/**
 * Splits a limit+1-fetched row set back down to `limit`, deriving the next
 * cursor from the last kept row when a page-(limit+1)th row proved more
 * data exists -- avoids a length===limit heuristic that can't distinguish
 * "exactly one page left" from "more pages exist".
 */
export function paginateKeyset<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => KeysetCursor,
): { page: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    return { page, nextCursor: encodeCursor(keyOf(page[page.length - 1]!)) };
  }
  return { page: rows, nextCursor: null };
}
