export declare function findTimestamptzColumns(sqlContents: string[]): Set<string>;

export interface TimestamptzTypingViolation {
  column: string;
  declaredType: string;
}

export declare function findMistypedColumns(
  fileContent: string,
  timestamptzColumns: Set<string>,
): TimestamptzTypingViolation[];

export interface TimestamptzCheckResult {
  file: string;
  violations: TimestamptzTypingViolation[];
}

export declare function walkTsFiles(dir: string): string[];

export interface CheckAllTimestamptzTypingOptions {
  migrationsDir: string;
  srcDir: string;
  readdirImpl?: (dir: string) => string[];
  readFileImpl?: (path: string) => string;
  walkImpl?: typeof walkTsFiles;
}

export declare function checkAllTimestamptzTyping(
  options: CheckAllTimestamptzTypingOptions,
): TimestamptzCheckResult[];

export interface CheckTimestamptzMainOptions {
  migrationsDir?: string;
  srcDir?: string;
  exit?: (code?: number) => void;
  log?: (msg: string) => void;
  runImpl?: typeof checkAllTimestamptzTyping;
}

export declare function main(options?: CheckTimestamptzMainOptions): Promise<void>;
