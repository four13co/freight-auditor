export declare function buildForeignKeyGraph(sqlContents: string[]): Map<string, Set<string>>;

export declare function extractAfterAllDeleteOrder(testFileContent: string): string[] | null;

export interface FkOrderViolation {
  parent: string;
  child: string;
}

export declare function findOrderViolations(
  deleteOrder: string[],
  fkGraph: Map<string, Set<string>>,
): FkOrderViolation[];

export interface TeardownCheckResult {
  file: string;
  violations: FkOrderViolation[];
}

export interface CheckAllTeardownsOptions {
  migrationsDir: string;
  testDbDir: string;
  readdirImpl?: (dir: string) => string[];
  readFileImpl?: (path: string) => string;
}

export declare function checkAllTeardowns(options: CheckAllTeardownsOptions): TeardownCheckResult[];

export interface CheckMainOptions {
  migrationsDir?: string;
  testDbDir?: string;
  exit?: (code?: number) => void;
  log?: (msg: string) => void;
  runImpl?: typeof checkAllTeardowns;
}

export declare function main(options?: CheckMainOptions): Promise<void>;
