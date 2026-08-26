import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import type { ExternalValueResolver } from '../../src/modules/reference-data/external-value-resolver.js';
import {
  loadNmfcLicenseConfig, NmfcLicenseConfigurationError, NmfcLicenseGate,
} from '../../src/modules/reference-data/nmfc-license-gate.js';

const client = {} as PoolClient;
const request = { sourceCode: 'NMFC', axisKey: { item: '12345' }, publishedFor: '2026-08-25' };

function delegate(sourceCode = 'NMFC'): ExternalValueResolver {
  return {
    sourceCode, resolverVersion: 'nmfc-db-v1',
    resolve: vi.fn(async () => ({
      status: 'UNAVAILABLE' as const, reason: 'VALUE_NOT_PUBLISHED' as const, resolverVersion: 'nmfc-db-v1',
    })),
  };
}

describe('NMFC licensing feature gate', () => {
  it('is disabled by default and never calls licensed data', async () => {
    const inner = delegate();
    const gate = new NmfcLicenseGate(inner, loadNmfcLicenseConfig({}));
    await expect(gate.resolve(client, request)).resolves.toMatchObject({
      status: 'UNAVAILABLE', reason: 'LICENSE_REQUIRED',
    });
    expect(inner.resolve).not.toHaveBeenCalled();
  });

  it('delegates only when explicitly enabled with a license identifier', async () => {
    const inner = delegate();
    const gate = new NmfcLicenseGate(inner, loadNmfcLicenseConfig({
      NMFC_LICENSE_ENABLED: 'true', NMFC_LICENSE_ID: 'licensed-customer-1',
    }));
    await gate.resolve(client, request);
    expect(inner.resolve).toHaveBeenCalledWith(client, request);
  });

  it('fails startup validation when enabled without a license identifier', () => {
    expect(() => loadNmfcLicenseConfig({ NMFC_LICENSE_ENABLED: '1' })).toThrow(NmfcLicenseConfigurationError);
    expect(() => new NmfcLicenseGate(delegate(), { enabled: true })).toThrow(NmfcLicenseConfigurationError);
  });

  it('rejects wrapping a non-NMFC resolver', () => {
    expect(() => new NmfcLicenseGate(delegate('EIA_DIESEL'), { enabled: false })).toThrow(NmfcLicenseConfigurationError);
  });
});
