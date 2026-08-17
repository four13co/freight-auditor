import type { RollbackToLastGoodOptions, RollbackToLastGoodResult } from './rollback-deploy.d.mts';

export interface RehearsalMainOptions {
  env?: NodeJS.ProcessEnv;
  exit?: (code?: number) => void;
  logError?: (msg: string) => void;
  logInfo?: (msg: string) => void;
  rollbackImpl?: (options: RollbackToLastGoodOptions) => Promise<RollbackToLastGoodResult>;
}

export declare function main(options?: RehearsalMainOptions): Promise<void>;
