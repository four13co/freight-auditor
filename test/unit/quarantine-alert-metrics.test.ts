import { describe, expect, it, beforeEach } from 'vitest';
import { recordRuleQuarantine, renderQuarantineAlertMetrics, resetQuarantineAlertMetricsForTest } from '../../src/jobs/quarantine-alert-metrics.js';

describe('quarantine-alert-metrics', () => {
  beforeEach(() => {
    resetQuarantineAlertMetricsForTest();
  });

  it('renders a zero counter before any quarantine is recorded', () => {
    expect(renderQuarantineAlertMetrics()).toBe(
      '# TYPE freight_rule_quarantine_total counter\nfreight_rule_quarantine_total 0\n',
    );
  });

  it('increments the counter each time a rule quarantine is recorded', () => {
    recordRuleQuarantine();
    expect(renderQuarantineAlertMetrics()).toContain('freight_rule_quarantine_total 1');
    recordRuleQuarantine();
    expect(renderQuarantineAlertMetrics()).toContain('freight_rule_quarantine_total 2');
  });
});
