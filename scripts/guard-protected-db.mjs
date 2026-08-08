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
    throw new Error(`Could not parse DATABASE_URL as a URL: ${databaseUrl}`);
  }
}

export function isProtectedHost(hostname, protectedHosts = PROTECTED_DB_HOSTS) {
  return protectedHosts.some((protectedHost) => hostname.endsWith(protectedHost));
}

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('::error::DATABASE_URL is not set');
    process.exit(1);
  }

  const host = extractHost(databaseUrl);

  if (isProtectedHost(host) && process.env.ALLOW_PROTECTED_DB_HOST !== '1') {
    console.error(
      `::error::Refusing to run against protected host "${host}". ` +
        'Set ALLOW_PROTECTED_DB_HOST=1 to override.',
    );
    process.exit(1);
  }

  console.log(`DATABASE_URL host "${host}" is not protected — proceeding.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
