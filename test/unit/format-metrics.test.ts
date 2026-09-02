import { describe, expect, it } from 'vitest';
import { escapeLabelValue } from '../../src/jobs/format-metrics.js';

describe('escapeLabelValue', () => {
  it('escapes backslashes before quotes so the result is valid Prometheus exposition format', () => {
    expect(escapeLabelValue('plain')).toBe('plain');
    expect(escapeLabelValue('has"quote')).toBe('has\\"quote');
    expect(escapeLabelValue('has\\backslash')).toBe('has\\\\backslash');
    expect(escapeLabelValue('back\\slash"and"quote')).toBe('back\\\\slash\\"and\\"quote');
  });
});
