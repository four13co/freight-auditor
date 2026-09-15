import { describe, it, expect } from 'vitest';
import { getDisplayName, getInitials } from '../src/lib/user-display.js';

describe('getDisplayName', () => {
  it('prefers a non-blank name', () => {
    expect(getDisplayName('Dana Mercer', 'dana@example.com')).toBe('Dana Mercer');
  });

  it('falls back to email when name is blank/whitespace', () => {
    expect(getDisplayName('   ', 'dana@example.com')).toBe('dana@example.com');
  });

  it('falls back to email when name is null/undefined', () => {
    expect(getDisplayName(null, 'dana@example.com')).toBe('dana@example.com');
    expect(getDisplayName(undefined, 'dana@example.com')).toBe('dana@example.com');
  });

  it('falls back to "Account" when neither name nor email is available', () => {
    expect(getDisplayName(null, null)).toBe('Account');
  });
});

describe('getInitials', () => {
  it('takes the first letter of up to two name words', () => {
    expect(getInitials('Dana Mercer', 'dana@example.com')).toBe('DM');
  });

  it('uses a single initial for a one-word name', () => {
    expect(getInitials('Dana', 'dana@example.com')).toBe('D');
  });

  it('caps at two initials for a name with more than two words', () => {
    expect(getInitials('Dana Marie Mercer', 'dana@example.com')).toBe('DM');
  });

  it('falls back to the email\'s first letter when name is blank', () => {
    expect(getInitials('  ', 'dana@example.com')).toBe('D');
  });

  it('falls back to "?" when neither name nor email is available', () => {
    expect(getInitials(null, null)).toBe('?');
  });
});
