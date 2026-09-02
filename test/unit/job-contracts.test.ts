import { describe, expect, it } from 'vitest';
import {
  JOB_NAMES,
  JobPayloadValidationError,
  jobPayloadSchemas,
  parseJobPayload,
} from '../../src/jobs/contracts.js';

const base = {
  schemaVersion: 1 as const,
  clientId: '10000000-0000-4000-8000-000000000001',
  idempotencyKey: 'audit:10000000-0000-4000-8000-000000000002:evaluate:v1',
  requestedAt: '2026-08-25T18:00:00-05:00',
};

describe('versioned job contracts', () => {
  it('keeps every registered queue name explicitly versioned and mapped to a schema', () => {
    expect(Object.values(JOB_NAMES)).toHaveLength(13);
    for (const name of Object.values(JOB_NAMES)) {
      expect(name).toMatch(/\.v1$/);
      expect(jobPayloadSchemas[name]).toBeDefined();
    }
  });

  it('parses a valid tenant-scoped, idempotent audit job', () => {
    const payload = { ...base, auditRunId: '10000000-0000-4000-8000-000000000002' };
    expect(parseJobPayload(JOB_NAMES.EVALUATE_AUDIT_V1, payload)).toEqual(payload);
  });

  it.each([
    ['missing tenant', { ...base, clientId: undefined, auditRunId: '10000000-0000-4000-8000-000000000002' }],
    ['empty idempotency key', { ...base, idempotencyKey: ' ', auditRunId: '10000000-0000-4000-8000-000000000002' }],
    ['unsupported schema version', { ...base, schemaVersion: 2, auditRunId: '10000000-0000-4000-8000-000000000002' }],
    ['unknown field', { ...base, auditRunId: '10000000-0000-4000-8000-000000000002', secret: 'do-not-log' }],
  ])('fails closed for %s', (_label, payload) => {
    expect(() => parseJobPayload(JOB_NAMES.EVALUATE_AUDIT_V1, payload)).toThrow(JobPayloadValidationError);
  });

  it('returns stable, sanitized validation details', () => {
    try {
      parseJobPayload(JOB_NAMES.EVALUATE_AUDIT_V1, {
        ...base,
        clientId: 'not-a-uuid',
        auditRunId: '10000000-0000-4000-8000-000000000002',
        credential: 'super-secret',
      });
      expect.fail('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(JobPayloadValidationError);
      expect(error).toMatchObject({
        code: 'JOB_PAYLOAD_INVALID',
        jobName: JOB_NAMES.EVALUATE_AUDIT_V1,
      });
      expect(JSON.stringify(error)).not.toContain('super-secret');
    }
  });

  it('requires reference publication pins instead of resolving mutable latest values', () => {
    expect(() => parseJobPayload(JOB_NAMES.SYNC_REFERENCE_DATA_V1, {
      ...base,
      source: 'eia_diesel',
    })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid claim escalation job', () => {
    const payload = { ...base, claimId: '10000000-0000-4000-8000-000000000003' };
    expect(parseJobPayload(JOB_NAMES.ESCALATE_CLAIM_V1, payload)).toEqual(payload);
  });

  it('fails closed for a claim escalation job missing claimId', () => {
    expect(() => parseJobPayload(JOB_NAMES.ESCALATE_CLAIM_V1, { ...base })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid claim follow-up job', () => {
    const payload = { ...base, claimId: '10000000-0000-4000-8000-000000000003' };
    expect(parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, payload)).toEqual(payload);
  });

  it('fails closed for a claim follow-up job missing claimId', () => {
    expect(() => parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, { ...base })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid claim-aging scan tick with no tenant scope', () => {
    const payload = { schemaVersion: 1 as const, requestedAt: base.requestedAt };
    expect(parseJobPayload(JOB_NAMES.SCAN_CLAIM_AGING_V1, payload)).toEqual(payload);
  });

  it('fails closed for a claim-aging scan tick carrying an unexpected clientId', () => {
    expect(() => parseJobPayload(JOB_NAMES.SCAN_CLAIM_AGING_V1, {
      schemaVersion: 1,
      requestedAt: base.requestedAt,
      clientId: base.clientId,
    })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid discovery-trigger job', () => {
    const payload = { ...base, auditRunId: '10000000-0000-4000-8000-000000000002' };
    expect(parseJobPayload(JOB_NAMES.DISCOVER_TRIGGERS_V1, payload)).toEqual(payload);
  });

  it('fails closed for a discovery-trigger job missing auditRunId', () => {
    expect(() => parseJobPayload(JOB_NAMES.DISCOVER_TRIGGERS_V1, { ...base }))
      .toThrow(JobPayloadValidationError);
  });

  it('fails closed for a discovery-trigger job carrying an unknown field', () => {
    expect(() => parseJobPayload(JOB_NAMES.DISCOVER_TRIGGERS_V1, {
      ...base, auditRunId: '10000000-0000-4000-8000-000000000002', sourceDocumentId: '10000000-0000-4000-8000-000000000003',
    })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid workflow-command scan tick with no tenant scope', () => {
    const payload = { schemaVersion: 1 as const, requestedAt: base.requestedAt };
    expect(parseJobPayload(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1, payload)).toEqual(payload);
  });

  it('fails closed for a workflow-command scan tick carrying an unexpected clientId', () => {
    expect(() => parseJobPayload(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1, {
      schemaVersion: 1,
      requestedAt: base.requestedAt,
      clientId: base.clientId,
    })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid run-workflow-command job', () => {
    const payload = {
      ...base,
      commandId: '10000000-0000-4000-8000-000000000002',
      workflowInstanceId: '10000000-0000-4000-8000-000000000003',
      commandType: 'send_reminder',
      payload: { to: 'a@example.com' },
    };
    expect(parseJobPayload(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, payload)).toEqual(payload);
  });

  it.each([
    ['missing commandId', (p: Record<string, unknown>) => { delete p.commandId; }],
    ['missing workflowInstanceId', (p: Record<string, unknown>) => { delete p.workflowInstanceId; }],
    ['invalid commandType', (p: Record<string, unknown>) => { p.commandType = 'Not-Valid!'; }],
    ['unknown field', (p: Record<string, unknown>) => { p.secret = 'do-not-log'; }],
  ])('fails closed for a run-workflow-command job with %s', (_label, mutate) => {
    const payload: Record<string, unknown> = {
      ...base,
      commandId: '10000000-0000-4000-8000-000000000002',
      workflowInstanceId: '10000000-0000-4000-8000-000000000003',
      commandType: 'send_reminder',
      payload: {},
    };
    mutate(payload);
    expect(() => parseJobPayload(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, payload)).toThrow(JobPayloadValidationError);
  });

  it('parses a valid outbox-message scan tick with no tenant scope', () => {
    const payload = { schemaVersion: 1 as const, requestedAt: base.requestedAt };
    expect(parseJobPayload(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1, payload)).toEqual(payload);
  });

  it('fails closed for an outbox-message scan tick carrying an unexpected clientId', () => {
    expect(() => parseJobPayload(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1, {
      schemaVersion: 1,
      requestedAt: base.requestedAt,
      clientId: base.clientId,
    })).toThrow(JobPayloadValidationError);
  });

  it('parses a valid deliver-outbox-message job', () => {
    const payload = {
      ...base,
      outboxMessageId: '10000000-0000-4000-8000-000000000002',
      workflowInstanceId: '10000000-0000-4000-8000-000000000003',
      commandId: '10000000-0000-4000-8000-000000000004',
      messageType: 'carrier_notify',
      payload: { to: 'carrier@example.com' },
    };
    expect(parseJobPayload(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1, payload)).toEqual(payload);
  });

  it.each([
    ['missing outboxMessageId', (p: Record<string, unknown>) => { delete p.outboxMessageId; }],
    ['missing workflowInstanceId', (p: Record<string, unknown>) => { delete p.workflowInstanceId; }],
    ['missing commandId', (p: Record<string, unknown>) => { delete p.commandId; }],
    ['invalid messageType', (p: Record<string, unknown>) => { p.messageType = 'Not-Valid!'; }],
    ['unknown field', (p: Record<string, unknown>) => { p.secret = 'do-not-log'; }],
  ])('fails closed for a deliver-outbox-message job with %s', (_label, mutate) => {
    const payload: Record<string, unknown> = {
      ...base,
      outboxMessageId: '10000000-0000-4000-8000-000000000002',
      workflowInstanceId: '10000000-0000-4000-8000-000000000003',
      commandId: '10000000-0000-4000-8000-000000000004',
      messageType: 'carrier_notify',
      payload: {},
    };
    mutate(payload);
    expect(() => parseJobPayload(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1, payload)).toThrow(JobPayloadValidationError);
  });

  it('parses a valid export-record job, defaulting a missing claimId/paymentGateDecisionId to null', () => {
    const payload = { ...base, systemCode: 'QUICKBOOKS', payload: { amount: 100 } };
    expect(parseJobPayload(JOB_NAMES.EXPORT_RECORD_V1, payload)).toEqual({
      ...payload,
      claimId: null,
      paymentGateDecisionId: null,
    });
  });

  it('parses a valid export-record job with an explicit claimId', () => {
    const payload = {
      ...base,
      claimId: '10000000-0000-4000-8000-000000000002',
      paymentGateDecisionId: null,
      systemCode: 'QUICKBOOKS',
      payload: {},
    };
    expect(parseJobPayload(JOB_NAMES.EXPORT_RECORD_V1, payload)).toEqual(payload);
  });

  it.each([
    ['missing systemCode', (p: Record<string, unknown>) => { delete p.systemCode; }],
    ['empty systemCode', (p: Record<string, unknown>) => { p.systemCode = ''; }],
    ['unknown field', (p: Record<string, unknown>) => { p.secret = 'do-not-log'; }],
  ])('fails closed for an export-record job with %s', (_label, mutate) => {
    const payload: Record<string, unknown> = { ...base, systemCode: 'QUICKBOOKS', payload: {} };
    mutate(payload);
    expect(() => parseJobPayload(JOB_NAMES.EXPORT_RECORD_V1, payload)).toThrow(JobPayloadValidationError);
  });
});
