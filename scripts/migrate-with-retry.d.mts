import type { ChildProcess } from 'node:child_process';

export interface MigrateWithRetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  spawnImpl?: (cmd: string, args: string[]) => ChildProcess;
  sleepImpl?: (ms: number) => Promise<void>;
  logInfo?: (msg: string) => void;
}

export declare function migrateWithRetry(
  args: string[],
  options?: MigrateWithRetryOptions,
): Promise<number>;

export interface MigrateMainOptions {
  argv?: string[];
  exit?: (code?: number) => void;
  migrateImpl?: typeof migrateWithRetry;
}

export declare function main(options?: MigrateMainOptions): Promise<void>;
