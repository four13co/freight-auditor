export interface ParsedLimitOffset {
  limit?: number;
  offset?: number;
}

export type LimitOffsetResult =
  | { ok: true; value: ParsedLimitOffset }
  | { ok: false; error: string };

// TODO: implement — stub so the test suite can prove red before green.
export function parseLimitOffset(
  _query: { limit?: string; offset?: string },
  _options: { maxLimit: number },
): LimitOffsetResult {
  throw new Error('not implemented');
}
