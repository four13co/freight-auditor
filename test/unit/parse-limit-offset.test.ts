import { describe, it, expect } from 'vitest';
import { parseLimitOffset } from '../../src/shared/parse-limit-offset.js';

describe('parseLimitOffset', () => {
  it('returns undefined limit/offset when neither is provided', () => {
    const result = parseLimitOffset({}, { maxLimit: 200 });
    expect(result).toEqual({ ok: true, value: { limit: undefined, offset: undefined } });
  });

  it('parses a valid limit and offset', () => {
    const result = parseLimitOffset({ limit: '25', offset: '10' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: true, value: { limit: 25, offset: 10 } });
  });

  it('rejects a non-integer limit', () => {
    const result = parseLimitOffset({ limit: 'abc' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: false, error: 'invalid limit: must be an integer between 1 and 200' });
  });

  it('rejects a limit below 1', () => {
    const result = parseLimitOffset({ limit: '0' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: false, error: 'invalid limit: must be an integer between 1 and 200' });
  });

  it('rejects a limit over maxLimit', () => {
    const result = parseLimitOffset({ limit: '201' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: false, error: 'invalid limit: must be an integer between 1 and 200' });
  });

  it('respects a custom maxLimit', () => {
    const result = parseLimitOffset({ limit: '201' }, { maxLimit: 500 });
    expect(result).toEqual({ ok: true, value: { limit: 201, offset: undefined } });
  });

  it('rejects a negative offset', () => {
    const result = parseLimitOffset({ offset: '-1' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: false, error: 'invalid offset: must be a non-negative integer' });
  });

  it('rejects a non-integer offset', () => {
    const result = parseLimitOffset({ offset: 'abc' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: false, error: 'invalid offset: must be a non-negative integer' });
  });

  it('accepts an offset of zero', () => {
    const result = parseLimitOffset({ offset: '0' }, { maxLimit: 200 });
    expect(result).toEqual({ ok: true, value: { limit: undefined, offset: 0 } });
  });
});
