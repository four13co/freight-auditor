import type { FindingRow, FindingsSummary, GateFailureRow } from '../src/lib/api.js';

// Shared test fixtures (86e2v251x): previously each of Dashboard.test.tsx,
// FindingsTable.test.tsx, and e2e/dashboard.spec.ts hand-defined its own
// ROWS/SUMMARY with different invoice numbers/amounts and inconsistent
// createdAt strategies (hardcoded literals vs. new Date().toISOString()) --
// the latter meant fixture behavior (e.g. formatAge output) could silently
// drift over time. All createdAt values here are fixed ISO-8601 literals.

export const DASHBOARD_SUMMARY: FindingsSummary = {
  recoverableOpen: '148320.0000',
  flaggedToday: 42,
  withCarriers: 27,
  recoveredLast30Days: '96411.0000',
};

// 3-row set: realistic invoice numbers, one row per direction variant used
// by Dashboard's detail-view and formatting assertions (populated
// ruleDescription, in_review status, and a null-driven row).
export const DASHBOARD_ROWS: FindingRow[] = [
  {
    id: 'f1',
    invoiceNumber: 'INV-90385',
    carrierName: 'Saia LTL',
    billed: '1876.4000',
    expected: '0.0000',
    varianceAmount: '1876.4000',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: 'Duplicate invoice for the same PRO',
  },
  {
    id: 'f2',
    invoiceNumber: 'INV-90408',
    carrierName: 'Old Dominion',
    billed: '5940.2000',
    expected: '5118.6000',
    varianceAmount: '821.6000',
    direction: 'OVERCHARGE',
    status: 'in_review',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: 'Fuel surcharge above the indexed rate',
  },
  {
    id: 'f3',
    invoiceNumber: 'INV-90331',
    carrierName: 'XPO Logistics',
    billed: '2077.3000',
    expected: null,
    varianceAmount: null,
    direction: 'INTEGRITY_ONLY',
    status: 'open',
    createdAt: '2026-08-14T00:00:00Z',
    ruleDescription: null,
  },
];

// 4-row set: distinct createdAt values (chronological sort) and a signed
// variance spread (positive/negative/null) for FindingsTable's sort tests.
export const SORTABLE_ROWS: FindingRow[] = [
  {
    id: 'f1',
    invoiceNumber: 'INV-A',
    carrierName: 'Saia LTL',
    billed: '10.0000',
    expected: '0.0000',
    varianceAmount: '10.00',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-10T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f2',
    invoiceNumber: 'INV-B',
    carrierName: 'Old Dominion',
    billed: '9.0000',
    expected: '0.0000',
    varianceAmount: '9.00',
    direction: 'OVERCHARGE',
    status: 'open',
    createdAt: '2026-08-12T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f3',
    invoiceNumber: 'INV-C',
    carrierName: 'XPO Logistics',
    billed: '5.0000',
    expected: '10.0000',
    varianceAmount: '-5.00',
    direction: 'UNDERCHARGE',
    status: 'open',
    createdAt: '2026-08-08T00:00:00Z',
    ruleDescription: null,
  },
  {
    id: 'f4',
    invoiceNumber: 'INV-D',
    carrierName: 'FedEx Freight',
    billed: '3.0000',
    expected: null,
    varianceAmount: null,
    direction: 'INTEGRITY_ONLY',
    status: 'open',
    createdAt: '2026-08-11T00:00:00Z',
    ruleDescription: null,
  },
];

// 86e2v17xn: gate-failure (rejected invoice) fixtures -- one row set with two
// entries for the same invoice (COLLECT_ALL: a rejected invoice can fail
// multiple gate criteria at once), one for a different invoice.
export const GATE_FAILURE_ROWS: GateFailureRow[] = [
  {
    id: 'gf1',
    auditRunId: 'run1',
    invoiceNumber: 'INV-REJECT-1',
    carrierName: 'Saia LTL',
    defect: 'Declared invoice total foots to the sum of line charges within tolerance.',
    citation: 'Invoice total (B3-07) must equal the sum of billed line items (ΣL1-04).',
    recordedAt: '2026-08-14T00:00:00Z',
  },
  {
    id: 'gf2',
    auditRunId: 'run1',
    invoiceNumber: 'INV-REJECT-1',
    carrierName: 'Saia LTL',
    defect: 'Every charge has a parseable amount (never guessed).',
    citation: null,
    recordedAt: '2026-08-14T00:00:00Z',
  },
  {
    id: 'gf3',
    auditRunId: 'run2',
    invoiceNumber: 'INV-REJECT-2',
    carrierName: null,
    defect: 'Ocean invoices must state currency per charge.',
    citation: 'C3/L1-20 must be present.',
    recordedAt: '2026-08-13T00:00:00Z',
  },
];
