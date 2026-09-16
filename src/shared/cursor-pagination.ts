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

export interface KeysetAnchorOptions {
  /** Table the correlated subquery re-reads the cursor row from (also the FROM ... AS cursor_row target). */
  table: string;
  /** Sort-key timestamp column on that table (e.g. "opened_at", "recorded_at", "created_at"). */
  tsColumn: string;
  /** The cursor row's id -- pushed onto `params` as a new positional param by this call. */
  cursorId: string;
  /**
   * Extra predicate(s) ANDed into the anchor subquery's own WHERE, for a
   * caller that must scope the anchor row explicitly rather than relying on
   * RLS alone (e.g. list-claims.ts's "cursor_row.client_id = $1"). Must
   * reference only params already bound before this call.
   */
  extraAnchorPredicate?: string;
}

export interface KeysetAnchorFrom {
  /** Appended directly to the caller's own FROM clause (starts with ", ("). */
  fromClauseAddition: string;
  /** The anchor subquery's timestamp-column alias (anchor_<tsColumn>), for use in buildKeysetTieBreak. */
  anchorTsAlias: string;
}

/**
 * Builds the correlated-subquery FROM addition shared by every keyset-paginated
 * list query: re-reads the cursor row's own sort-key timestamp fresh from the
 * DB (never a client-round-tripped value -- see list-claims.ts's cursor doc
 * comment for why that silently breaks same-instant tie-breaks) plus its id,
 * aliased as `cursor_anchor`. The timestamp alias is column-specific
 * (anchor_<tsColumn>) so two different sort columns can never collide.
 */
export function buildKeysetAnchorFrom(params: unknown[], options: KeysetAnchorOptions): KeysetAnchorFrom {
  params.push(options.cursorId);
  const cursorIdIdx = params.length;
  const anchorTsAlias = `anchor_${options.tsColumn}`;
  const extra = options.extraAnchorPredicate ? ` AND ${options.extraAnchorPredicate}` : '';
  const fromClauseAddition = `, (
      SELECT ${options.tsColumn} AS ${anchorTsAlias}, id AS anchor_id
        FROM ${options.table} AS cursor_row
       WHERE cursor_row.id = $${cursorIdIdx}${extra}
    ) cursor_anchor`;
  return { fromClauseAddition, anchorTsAlias };
}

/**
 * Builds the tie-break predicate that pairs with buildKeysetAnchorFrom's
 * subquery: resume strictly after the anchor row in a (tsColumn DESC, id ASC)
 * ordering. `tsColumnRef`/`idColumnRef` are the exact column references to
 * use in the outer query (bare `opened_at` when only one table is in scope,
 * `gate_failure.recorded_at` when qualification is needed) -- this function
 * doesn't guess at qualification, callers already know which they need.
 */
export function buildKeysetTieBreak(tsColumnRef: string, idColumnRef: string, anchorTsAlias: string): string {
  return `(${tsColumnRef} < cursor_anchor.${anchorTsAlias} OR (${tsColumnRef} = cursor_anchor.${anchorTsAlias} AND ${idColumnRef} > cursor_anchor.anchor_id))`;
}

/**
 * Builds the LIMIT (cursor mode) or LIMIT..OFFSET (legacy offset mode)
 * clause shared by every list query, pushing the corresponding param(s) onto
 * `params` and returning their positional placeholders.
 */
export function buildLimitOffsetClause(
  params: unknown[],
  options: { limit: number; offset?: number; hasCursor: boolean },
): string {
  if (options.hasCursor) {
    params.push(options.limit);
    return `LIMIT $${params.length}`;
  }
  params.push(options.limit, options.offset ?? 0);
  return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}
