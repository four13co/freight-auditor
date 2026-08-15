export interface RunResult {
  code: number;
  stdout?: string;
}

export declare function isForwardProgress(
  currentTagSha: string,
  targetSha: string,
  options?: { runImpl?: (cmd: string, args: string[]) => Promise<RunResult> },
): Promise<boolean>;

export interface AdvanceLastGoodTagOptions {
  lastGoodTag: string;
  targetSha: string;
  runImpl?: (cmd: string, args: string[]) => Promise<RunResult>;
  logInfo?: (msg: string) => void;
}

export interface AdvanceLastGoodTagResult {
  advanced: boolean;
  reason?: string;
}

export declare function advanceLastGoodTag(
  options: AdvanceLastGoodTagOptions,
): Promise<AdvanceLastGoodTagResult>;

export interface AdvanceMainOptions {
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => void;
  advanceImpl?: typeof advanceLastGoodTag;
  logError?: (msg: string) => void;
}

export declare function main(options?: AdvanceMainOptions): Promise<void>;
