import type { FindingRow } from './api.js';

/**
 * Maps a FindingRow to its dashboard display label + tag colors (86e2u7j1y).
 * The mock's tags don't map 1:1 onto variance_status (migrations/0002_enums.sql:
 * open, in_review, accepted, waived, queued_for_dispute, disputed, recovered,
 * written_off, closed) -- this is the explicit, documented mapping:
 *
 *   "Overcharge" / "Undercharge" <- direction (OVERCHARGE / UNDERCHARGE),
 *     when expected is resolved (not null) -- direction is the primary signal
 *     the mock's row-level tag encodes, not status.
 *   "Needs data"   <- expected is null (unresolved expected amount) --
 *     overrides the direction-based label per the item's explicit note.
 *   "In review"    <- status === 'in_review'
 *   "Queued"       <- status === 'open' || status === 'queued_for_dispute'
 *   (fallback)     <- any other status (accepted/waived/disputed/recovered/
 *     written_off/closed) renders its own status string title-cased, since
 *     the mock's sample data doesn't cover them and no rule was specified.
 */
export interface StatusDisplay {
  label: string;
  tagBg: string;
  tagFg: string;
}

const TAGS: Record<string, { bg: string; fg: string }> = {
  Overcharge: { bg: '#ffe0d9', fg: '#7c1405' },
  Undercharge: { bg: '#eae7e7', fg: '#444141' },
  'In review': { bg: '#201e1d', fg: '#f3f2f2' },
  Queued: { bg: 'transparent', fg: 'rgba(32,30,29,0.65)' },
  'Needs data': { bg: '#d7d3d3', fg: '#2d2b2b' },
};

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getStatusDisplay(row: Pick<FindingRow, 'status' | 'direction' | 'expected'>): StatusDisplay {
  let label: string;
  if (row.expected === null) {
    label = 'Needs data';
  } else if (row.status === 'in_review') {
    label = 'In review';
  } else if (row.status === 'open' || row.status === 'queued_for_dispute') {
    label = 'Queued';
  } else if (row.direction === 'OVERCHARGE') {
    label = 'Overcharge';
  } else if (row.direction === 'UNDERCHARGE') {
    label = 'Undercharge';
  } else {
    label = titleCase(row.status);
  }

  const tag = TAGS[label] ?? { bg: '#d7d3d3', fg: '#2d2b2b' };
  return { label, tagBg: tag.bg, tagFg: tag.fg };
}
