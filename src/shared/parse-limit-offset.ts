export interface ParsedLimitOffset {
  limit?: number;
  offset?: number;
}

export type LimitOffsetResult =
  | { ok: true; value: ParsedLimitOffset }
  | { ok: false; error: string };

/**
 * Parses and validates the `limit`/`offset` query-string pair shared by every
 * offset-paginated route. Returns the first validation error verbatim as an
 * `error` string (callers send it with a 400), matching the wording every
 * call site already used before this was extracted.
 */
export function parseLimitOffset(
  query: { limit?: string; offset?: string },
  options: { maxLimit: number },
): LimitOffsetResult {
  let limit: number | undefined;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > options.maxLimit) {
      return { ok: false, error: `invalid limit: must be an integer between 1 and ${options.maxLimit}` };
    }
  }

  let offset: number | undefined;
  if (query.offset !== undefined) {
    offset = Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, error: 'invalid offset: must be a non-negative integer' };
    }
  }

  return { ok: true, value: { limit, offset } };
}
