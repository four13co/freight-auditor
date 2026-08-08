export declare const PROTECTED_DB_HOSTS: string[];
export declare function extractHost(databaseUrl: string): string;
export declare function isProtectedHost(hostname: string, protectedHosts?: string[]): boolean;
