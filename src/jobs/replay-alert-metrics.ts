/**
 * P6.C.5: the alert signal for a replay pin/hash mismatch. No generic
 * alerting abstraction exists in this codebase (confirmed by exhaustive
 * grep during shaping) -- the established pattern for "something needs a
 * human's attention" is the hand-rolled Prometheus /metrics endpoint
 * (jobs/metrics.ts, jobs/discovery-metrics.ts, P6.C.4). This mirrors that
 * pattern exactly: an in-process counter, incremented at the one call site
 * that observes a ReplayIntegrityError (audit-runs-routes.ts's POST
 * .../replay handler), rendered in Prometheus exposition format.
 *
 * In-memory (not durable) is a deliberate choice, not a shortcut: the AC
 * only requires the counter to increment and be scrapeable, not to survive
 * a process restart, and every existing counter this surface exposes
 * (freight_job_retries, freight_ai_proposals_total, etc.) is likewise
 * computed fresh per request from process/DB state, never cross-restart
 * durable in its own right.
 */
let replayIntegrityFailures = 0;

export function recordReplayIntegrityFailure(): void {
  replayIntegrityFailures += 1;
}

export function renderReplayAlertMetrics(): string {
  return [
    '# TYPE freight_replay_integrity_failures_total counter',
    `freight_replay_integrity_failures_total ${replayIntegrityFailures}`,
  ].join('\n') + '\n';
}

/** Test-only: reset process-global state between test cases. */
export function resetReplayAlertMetricsForTest(): void {
  replayIntegrityFailures = 0;
}
