// 86e2v892h: single canonical source for variance_status's value sets, so
// migrations/0002_enums.sql, src/server/app.ts, and web/'s FindingDetail.tsx
// stop hand-maintaining separate copies. migrations/0002_enums.sql itself
// stays the ultimate source of truth (DDL has no TS import path) -- this
// mirrors it exactly; keep both in sync if the enum ever changes.
//
// web/ and src/ don't share a package boundary, but Vite follows relative
// imports outside its project root and bundles them fine (verified via a
// real `npm run build`) -- so this file is imported directly from both sides
// rather than duplicated.
export const ALL_VARIANCE_STATUSES = [
  'open', 'in_review', 'accepted', 'waived',
  'queued_for_dispute', 'disputed', 'recovered', 'written_off', 'closed',
] as const;

// 86e2v1xyr's explicit scope rule: the drawer's write path (and the PATCH
// route backing it) is scoped to the same 5 values the status FILTER
// dropdown exposes -- a finding set to one of the other 4 enum values would
// become unreachable through the UI. Deliberately narrower than, and
// separate from, ALL_VARIANCE_STATUSES (a filter/list param and a write
// target are different concerns) -- do not collapse the two.
export const WRITABLE_VARIANCE_STATUSES = [
  'open', 'in_review', 'queued_for_dispute', 'disputed', 'closed',
] as const;
