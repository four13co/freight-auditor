import { describe, expect, it, beforeEach } from 'vitest';
import { recordReplayIntegrityFailure, renderReplayAlertMetrics, resetReplayAlertMetricsForTest } from '../../src/jobs/replay-alert-metrics.js';

describe('replay-alert-metrics', () => {
  beforeEach(() => {
    resetReplayAlertMetricsForTest();
  });

  it('renders a zero counter before any failure is recorded', () => {
    expect(renderReplayAlertMetrics()).toBe(
      '# TYPE freight_replay_integrity_failures_total counter\nfreight_replay_integrity_failures_total 0\n',
    );
  });

  it('increments the counter each time a replay integrity failure is recorded', () => {
    recordReplayIntegrityFailure();
    expect(renderReplayAlertMetrics()).toContain('freight_replay_integrity_failures_total 1');
    recordReplayIntegrityFailure();
    expect(renderReplayAlertMetrics()).toContain('freight_replay_integrity_failures_total 2');
  });
});
