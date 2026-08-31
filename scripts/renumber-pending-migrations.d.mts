export interface MigrationFileEntry {
  number: string;
  file: string;
}

export interface RenumberPlanEntry {
  from: string;
  to: string;
  digits: number;
}

export interface ListMigrationFilesOptions {
  readdirImpl?: (dir: string) => string[];
}

export declare function listMigrationFiles(
  migrationsDir: string,
  options?: ListMigrationFilesOptions,
): MigrationFileEntry[];

export declare function planRenumbering(
  diskFiles: MigrationFileEntry[],
  appliedNames: Set<string>,
): RenumberPlanEntry[];

export interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: { name: string }[] }>;
  end(): Promise<void>;
}

export interface RenumberPendingMigrationsOptions {
  connectionString: string;
  migrationsDir: string;
  clientImpl?: new (opts: { connectionString: string }) => PgClientLike;
  renameImpl?: (from: string, to: string) => void;
  listImpl?: typeof listMigrationFiles;
  logInfo?: (msg: string) => void;
}

export declare function renumberPendingMigrations(
  options: RenumberPendingMigrationsOptions,
): Promise<RenumberPlanEntry[]>;

export interface RenumberMainOptions {
  env?: NodeJS.ProcessEnv;
  migrationsDir?: string;
  exit?: (code?: number) => void;
  runImpl?: typeof renumberPendingMigrations;
}

export declare function main(options?: RenumberMainOptions): Promise<void>;
