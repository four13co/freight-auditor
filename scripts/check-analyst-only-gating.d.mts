export declare const SRC_SERVER_DIR: string;

export declare const ROLE_SCOPED_PREHANDLERS: string[];

export interface AllowListedRoute {
  file: string;
  method: string;
  path: string;
  reason: string;
}

export declare const ALLOW_LISTED_ROUTES: AllowListedRoute[];

export declare function findMatchingBrace(content: string, openIndex: number): number;

export interface RegisterBlock {
  varName: string;
  start: number;
  end: number;
  hasRoleGate: boolean;
}

export declare function findRegisterBlocks(content: string): RegisterBlock[];

export interface MutatingRouteCall {
  scopeVar: string;
  method: string;
  path: string;
  index: number;
}

export declare function findMutatingRouteCalls(content: string): MutatingRouteCall[];

export interface GatingViolation {
  file: string;
  method: string;
  path: string;
}

export declare function checkFileGating(fileName: string, content: string): GatingViolation[];

export declare function checkAllRoutes(opts?: {
  srcServerDir?: string;
  readdirImpl?: (dir: string) => string[];
  readFileImpl?: (path: string) => string;
}): GatingViolation[];

export declare function main(opts?: {
  srcServerDir?: string;
  exit?: (code?: number) => never;
  log?: (msg: string) => void;
  runImpl?: typeof checkAllRoutes;
}): Promise<void>;
