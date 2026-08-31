/**
 * The single source of truth for a claim's terminal statuses and the
 * audit_event names that record reaching each one (86e31a9d6). This set was
 * previously copy-pasted as raw literals across 5+ files under a "disclosed
 * duplication" rationale from when those PRs were parallel/unmerged
 * branches; now that they've all merged (fd229d6, fd1c7e8, e70df35,
 * b1cd2e3), every call site imports from here instead.
 */
export const CLAIM_TERMINAL_EVENTS = {
  recovered: 'claim.recovered',
  denied: 'claim.denied',
  written_off: 'claim.written_off',
} as const;

export type ClaimTerminalStatus = keyof typeof CLAIM_TERMINAL_EVENTS;

export const CLAIM_TERMINAL_STATUSES: ReadonlySet<ClaimTerminalStatus> = new Set(
  Object.keys(CLAIM_TERMINAL_EVENTS) as ClaimTerminalStatus[],
);

export const CLAIM_TERMINAL_EVENT_NAMES: readonly string[] = Object.values(CLAIM_TERMINAL_EVENTS);

export function isClaimTerminalStatus(status: string): status is ClaimTerminalStatus {
  return (CLAIM_TERMINAL_STATUSES as ReadonlySet<string>).has(status);
}
