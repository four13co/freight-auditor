import { betterAuth } from 'better-auth';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';

/**
 * better-auth session mechanism (86e2v1bbr). Option A (of the two named in
 * the item's shape): app_user IS better-auth's user table -- verified via
 * app_user's grants/RLS before choosing (see migrations/0014's comment
 * header for the full rationale), not guessed.
 *
 * `name`/`email_verified`/`updated_at` are the columns migration 0014 added
 * to app_user for this; `full_name`/`is_internal`/`is_active` stay
 * untouched and are simply fields better-auth doesn't know about.
 *
 * No login UI is built here (86e2v1bdj, explicitly out of this item's
 * scope) -- emailAndPassword is enabled so a real session can be created via
 * better-auth's own API (sign-up/sign-in) as the "session-creation helper"
 * the item's AC3 allows in place of a UI round-trip.
 */
function createAuth() {
  return betterAuth({
    database: getPool(),
    // app_user.id is `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
    // (migration 0003) -- better-auth's default id generator produces
    // plain random strings, which fail Postgres's uuid type check on
    // insert. The built-in "uuid" shorthand left ba_account's id null on
    // this better-auth version (reproduced against the ephemeral DB
    // before switching to this explicit function) -- generating the id
    // ourselves is the same outcome (a real UUID for every model, ba_*
    // tables' `text` PKs accept any string) without relying on that
    // shorthand's internal wiring.
    advanced: {
      database: { generateId: () => randomUUID() },
    },
    secret: process.env.SESSION_SECRET,
    baseURL: process.env.APP_URL,
    user: {
      modelName: 'app_user',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'ba_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'ba_account',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        idToken: 'id_token',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'ba_verification',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    emailAndPassword: {
      enabled: true,
    },
  });
}

type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/**
 * Lazily construct (and memoise) the better-auth instance, matching
 * src/db/pool.ts's own getPool() pattern -- module-scope construction would
 * call getPool() (and therefore requireDatabaseUrl()) at import time, which
 * breaks every DB-free unit test that imports app.ts/tenant-auth.ts
 * (test/unit/health.test.ts deliberately unsets DATABASE_URL and expects
 * imports to succeed regardless).
 */
export function getAuth(): Auth {
  if (!instance) {
    instance = createAuth();
  }
  return instance;
}
