export declare const RLS_GUARD_TEST_PATH: string;
export declare const DEPLOY_WORKFLOW_TEST_PATH: string;
export declare const DEPLOY_WORKFLOW_TEST_FILTER: string;
export declare const BACKUP_RESTORE_DOC_PATH: string;
export declare const ON_CALL_DOC_PATH: string;
export declare const BACKUPS_STATUS_LABEL: string;

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type RunImpl = (cmd: string, args: string[]) => Promise<RunResult>;

export declare function defaultRun(cmd: string, args: string[]): Promise<RunResult>;

export interface CheckResult {
  pass: boolean;
  detail: string;
  invokes?: string;
  path?: string;
}

export declare function checkRlsGuard(options?: { runImpl?: RunImpl }): Promise<CheckResult>;
export declare function checkMonitoringWired(options?: { runImpl?: RunImpl }): Promise<CheckResult>;
export declare function checkBackupsDocumented(options?: { docsRoot?: string }): CheckResult;
export declare function checkOnCallDocumented(options?: { docsRoot?: string }): CheckResult;

export interface LaunchReadinessReport {
  ready: boolean;
  items: {
    rls: CheckResult;
    backups: CheckResult;
    monitoring: CheckResult;
    onCall: CheckResult;
  };
}

export declare function runLaunchReadinessCheck(options?: {
  runImpl?: RunImpl;
  docsRoot?: string;
}): Promise<LaunchReadinessReport>;
