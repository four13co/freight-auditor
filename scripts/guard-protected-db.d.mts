export declare const PROTECTED_DB_HOSTS: string[];
export declare function extractHost(databaseUrl: string): string;
export declare function isProtectedHost(hostname: string, protectedHosts?: string[]): boolean;

export interface GuardMainOptions {
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => void;
  logError?: (msg: string) => void;
  logInfo?: (msg: string) => void;
}

export declare function main(options?: GuardMainOptions): void;
