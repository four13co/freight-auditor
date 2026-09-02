/**
 * P6.C.9: the alert signal for a reversal-triggered rule quarantine.
 * Mirrors replay-alert-metrics.ts's shape exactly (P6.C.5/86e2zfk09) --
 * same in-process-counter rationale applies verbatim: the AC only needs
 * the counter to increment and be scrapeable, not to survive a process
 * restart, and every existing series this /metrics endpoint exposes is
 * likewise computed fresh per request.
 */
let ruleQuarantines = 0;

export function recordRuleQuarantine(): void {
  ruleQuarantines += 1;
}

export function renderQuarantineAlertMetrics(): string {
  return [
    '# TYPE freight_rule_quarantine_total counter',
    `freight_rule_quarantine_total ${ruleQuarantines}`,
  ].join('\n') + '\n';
}

/** Test-only: reset process-global state between test cases. */
export function resetQuarantineAlertMetricsForTest(): void {
  ruleQuarantines = 0;
}
