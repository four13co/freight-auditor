export interface RunResult {
  stdout: string;
}

export interface TriggerBuildResult {
  status: string;
  raw: string;
}

export interface RollbackToLastGoodOptions {
  lastGoodTag: string;
  caproverUrl: string;
  caproverAppToken: string;
  caproverAppName: string;
  runImpl?: (cmd: string, args: string[]) => Promise<RunResult>;
  triggerBuildImpl?: (url: string, appToken: string, appName: string) => Promise<TriggerBuildResult>;
}

export interface RollbackToLastGoodResult {
  rolledBack: boolean;
  lastGoodSha: string | null;
  reason?: string;
}

export declare function rollbackToLastGood(
  options: RollbackToLastGoodOptions,
): Promise<RollbackToLastGoodResult>;

export declare function redactToken(message: string, token: string | undefined): string;

export declare function defaultTriggerBuild(
  caproverUrl: string,
  caproverAppToken: string,
  caproverAppName: string,
): Promise<TriggerBuildResult>;

export interface RollbackMainOptions {
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => void;
  logError?: (msg: string) => void;
  logInfo?: (msg: string) => void;
  rollbackImpl?: (options: RollbackToLastGoodOptions) => Promise<RollbackToLastGoodResult>;
}

export declare function main(options?: RollbackMainOptions): Promise<void>;
