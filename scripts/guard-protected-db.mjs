#!/usr/bin/env node
// Refuses to proceed if DATABASE_URL resolves to a protected/shared host,
// unless ALLOW_PROTECTED_DB_HOST=1 is explicitly set. Guards the CI
// migrate-database job (and anything else that shells out to a real DB)
// against accidentally running against Neon/Supabase/RDS etc.

export const PROTECTED_DB_HOSTS = ['neon.tech', 'supabase.co', 'rds.amazonaws.com'];

export function extractHost(databaseUrl) {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    throw new Error('Could not parse DATABASE_URL as a URL — check its shape (scheme, encoding).');
  }
}

export function isProtectedHost(hostname, protectedHosts = PROTECTED_DB_HOSTS) {
  return protectedHosts.some((protectedHost) => hostname.endsWith(protectedHost));
}

/**
 * The CLI body, factored out so tests can drive it in-process (injectable env/exit/log)
 * instead of only via a subprocess — a subprocess call exercises real behavior but is
 * invisible to v8 coverage instrumentation in the parent process (86e2u72u2).
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(code?: number) => void} [opts.exit]
 * @param {(msg: string) => void} [opts.logError]
 * @param {(msg: string) => void} [opts.logInfo]
 */
export function main({
  env = process.env,
  exit = process.exit,
  logError = console.error,
  logInfo = console.log,
} = {}) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    logError('::error::DATABASE_URL is not set');
    exit(1);
    return;
  }

  let host;
  try {
    host = extractHost(databaseUrl);
  } catch (err) {
    logError(`::error::${err.message}`);
    exit(1);
    return;
  }

  if (isProtectedHost(host) && env.ALLOW_PROTECTED_DB_HOST !== '1') {
    logError(
      `::error::Refusing to run against protected host "${host}". ` +
        'Set ALLOW_PROTECTED_DB_HOST=1 to override.',
    );
    exit(1);
    return;
  }

  logInfo(`DATABASE_URL host "${host}" is not protected — proceeding.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
