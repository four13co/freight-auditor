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
  runImpl?: (cmd: string, args: string[]) => Promise<RunResult>;
  triggerBuildImpl?: (url: string, appToken: string) => Promise<TriggerBuildResult>;
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
