import type pg from 'pg';
import type {
  ExternalValueRequest,
  ExternalValueResolution,
  ExternalValueResolver,
} from './external-value-resolver.js';

export interface NmfcLicenseConfig {
  enabled: boolean;
  licenseId?: string;
}

export class NmfcLicenseConfigurationError extends Error {}

/** Parse the operational gate without ever exposing the license identifier in results/logs. */
export function loadNmfcLicenseConfig(env: NodeJS.ProcessEnv = process.env): NmfcLicenseConfig {
  const enabled = env.NMFC_LICENSE_ENABLED === '1' || env.NMFC_LICENSE_ENABLED?.toLowerCase() === 'true';
  const licenseId = env.NMFC_LICENSE_ID?.trim();
  if (enabled && !licenseId) {
    throw new NmfcLicenseConfigurationError('NMFC_LICENSE_ID is required when NMFC licensing is enabled');
  }
  return { enabled, ...(licenseId ? { licenseId } : {}) };
}

/** Deny-by-default decorator around any future licensed NMFC data adapter. */
export class NmfcLicenseGate implements ExternalValueResolver {
  readonly sourceCode = 'NMFC';
  readonly resolverVersion: string;

  constructor(
    private readonly delegate: ExternalValueResolver,
    private readonly config: NmfcLicenseConfig,
  ) {
    if (delegate.sourceCode !== this.sourceCode) {
      throw new NmfcLicenseConfigurationError(`NMFC gate cannot wrap ${delegate.sourceCode}`);
    }
    if (config.enabled && !config.licenseId?.trim()) {
      throw new NmfcLicenseConfigurationError('NMFC license gate enabled without a license identifier');
    }
    this.resolverVersion = `nmfc-license-gate-v1+${delegate.resolverVersion}`;
  }

  resolve(client: pg.PoolClient, request: ExternalValueRequest): Promise<ExternalValueResolution> {
    if (!this.config.enabled) {
      return Promise.resolve({
        status: 'UNAVAILABLE', reason: 'LICENSE_REQUIRED', resolverVersion: this.resolverVersion,
      });
    }
    return this.delegate.resolve(client, request);
  }
}
