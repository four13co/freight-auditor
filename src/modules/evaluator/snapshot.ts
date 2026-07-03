import { createHash } from 'node:crypto';
import type { ComposedRubric } from '../rubric-resolver/standard-rubric.js';

/**
 * Deterministic content hash of a composed rubric (Master Spec §3.0, §5.4).
 *
 * The hash pins an audit_run to the exact rubric it ran against, so a finding
 * replays byte-identically. Determinism requires a STABLE serialization: keys
 * are sorted recursively so two structurally-equal rubrics hash the same
 * regardless of property insertion order.
 */
export function rubricContentHash(rubric: ComposedRubric): string {
  return createHash('sha256').update(stableStringify(rubric)).digest('hex');
}

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
