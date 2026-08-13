export declare const DEFAULT_RETRIES: number;
export declare const DEFAULT_INTERVAL_MS: number;

export interface PollHealthOptions {
  healthUrl: string;
  expectedBuild: string;
  retries?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  runImpl?: (cmd: string, args: string[]) => Promise<unknown>;
}

export interface PollHealthResult {
  healthy: boolean;
  lastBuild: string | null;
  attempts: number;
  superseded?: boolean;
}

export declare function pollHealth(options: PollHealthOptions): Promise<PollHealthResult>;

/**
 * Builds the `/health` URL from the app's base URL, prepending `https://` when the value
 * carries no scheme (the 1Password vault stores bare hostnames).
 */
export declare function buildHealthUrl(appUrl: string): string;
