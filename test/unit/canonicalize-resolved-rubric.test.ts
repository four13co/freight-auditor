import { describe, expect, it } from 'vitest';
import { canonicalizeResolvedRubricDocument } from '../../src/modules/rubric-resolver/canonicalize-resolved-rubric.js';

describe('resolved rubric canonicalization', () => {
  it('produces identical bytes/hash for reordered keys and set-like criteria', () => {
    const left = {
      schemaVersion: 1, resolverVersion: 'resolver-v1',
      criteria: [{ criterionKey: 'B', threshold: { decimal: '1.00' } }, { criterionKey: 'A' }],
      mode: 'ROAD',
    };
    const right = {
      mode: 'ROAD', criteria: [{ criterionKey: 'A' }, { threshold: { decimal: '1' }, criterionKey: 'B' }],
      resolverVersion: 'resolver-v1', schemaVersion: 1,
    };
    const a = canonicalizeResolvedRubricDocument(left);
    const b = canonicalizeResolvedRubricDocument(right);
    expect(a.json).toBe(b.json);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves order for semantic arrays such as AST arguments', () => {
    const first = canonicalizeResolvedRubricDocument({
      schemaVersion: 1, resolverVersion: 'v1', criteria: [], ast: { args: [1, 2] },
    });
    const second = canonicalizeResolvedRubricDocument({
      schemaVersion: 1, resolverVersion: 'v1', criteria: [], ast: { args: [2, 1] },
    });
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('fails closed on non-JSON or incomplete documents', () => {
    expect(() => canonicalizeResolvedRubricDocument({ schemaVersion: 1, resolverVersion: 'v1' }))
      .toThrowError(expect.objectContaining({ code: 'RESOLVED_RUBRIC_DOCUMENT_INVALID' }));
    expect(() => canonicalizeResolvedRubricDocument({
      schemaVersion: 1, resolverVersion: 'v1', criteria: [], invalid: Number.NaN,
    })).toThrow();
  });
});
