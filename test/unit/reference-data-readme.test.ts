import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '../../src/modules/reference-data/README.md');

/**
 * 86e367rab: EiaFuelIndexResolver, MileageResolver, OceanIndexResolver,
 * NmfcLicenseGate, ExternalResolverRegistry, and external-value-store.ts
 * have zero production callers repo-wide (only their own unit tests invoke
 * them). This encodes the task's acceptance criterion that the module's
 * deferred status is documented explicitly, matching rate-engine's own
 * README precedent, rather than left as a stale scaffolding placeholder.
 */
describe('reference-data README', () => {
  const content = readFileSync(README_PATH, 'utf8');

  it('no longer reads as an unimplemented scaffolding placeholder', () => {
    expect(content).not.toMatch(/No implementation yet/);
  });

  it('names the unwired external-value-resolution classes', () => {
    for (const name of [
      'ExternalResolverRegistry',
      'EiaFuelIndexResolver',
      'MileageResolver',
      'OceanIndexResolver',
      'NmfcLicenseGate',
    ]) {
      expect(content).toContain(name);
    }
  });

  it('explicitly documents the subsystem as deliberately deferred, not merely unfinished', () => {
    expect(content).toMatch(/deferred/i);
    expect(content).toMatch(/zero (production )?callers/i);
  });

  it('states what would unblock wiring it in', () => {
    expect(content.toLowerCase()).toContain('unblocks');
  });
});
