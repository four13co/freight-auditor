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
    expect(Object.values(JOB_NAMES)).toHaveLength(6);
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

  it('parses a valid tenant-scoped claim follow-up job', () => {
    const payload = { ...base, claimId: '10000000-0000-4000-8000-000000000003' };
    expect(parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, payload)).toEqual(payload);
  });

  it('rejects a claim follow-up job missing claimId', () => {
    expect(() => parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, { ...base })).toThrow(JobPayloadValidationError);
  });
});
