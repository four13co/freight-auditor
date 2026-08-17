-- Up Migration
-- ---------------------------------------------------------------------------
-- 0014: better-auth session wiring (86e2v1bbr).
--
-- Option A taken (of the two named in the item's shape): app_user IS
-- better-auth's user table, not a separate table joined to it. Verified
-- before writing this migration, not guessed:
--   - app_user carries no RLS policy (absent from 0009's apply_tenant_rls
--     list) and 0010 grants freight_app full SELECT/INSERT/UPDATE/DELETE on
--     it (it's not in 0010's append-only list) -- better-auth's own writes
--     (session create, updatedAt bumps) need plain CRUD, which app_user
--     already has.
--   - better-auth's core userSchema requires `name` as a non-nullable
--     string on its OWN reads/writes (auth.api.*); app_user's existing
--     `full_name` column is nullable and real rows can have it unset.
--     Remapping better-auth's `name` field onto `full_name` via `fields`
--     would fail zod validation on any such row, so this migration adds a
--     separate `name` column instead (additive -- full_name is untouched,
--     never renamed). `name` itself stays NULLABLE at the DB level (NOT a
--     zod-enforced NOT NULL): five existing call sites insert app_user rows
--     with only `email` (test fixtures for FK purposes, unrelated to
--     better-auth) and forcing NOT NULL would require editing all of them
--     for a column they never read. better-auth's own row-creation path
--     (auth.api.signUpEmail) requires `name` in its request body (zod-
--     validated on input, verified end-to-end against this DB before this
--     migration was finalized), so every better-auth-created user has one;
--     only pre-existing/test-fixture rows can have it NULL.
--   - better-auth also requires `emailVerified` (bool), `updatedAt`
--     (timestamp), and `image` (nullable text), none of which app_user had.
--
-- Schema verified against better-auth's own generator, not hand-inferred
-- alone: `npx @better-auth/cli generate` (reads the actual betterAuth()
-- config in src/auth/better-auth.ts) run against a DB with an EARLIER draft
-- of this migration applied reported only one diff -- the missing `image`
-- column, added below -- confirming the modelName/fields remaps for
-- app_user/ba_session/ba_account/ba_verification all match what better-auth
-- itself expects, including ba_verification (never exercised directly by
-- name in any test in this PR, since nothing in this item's scope triggers
-- email verification -- this generator diff is its only correctness check).
--
-- better-auth's own session/account/verification tables are new (better-auth
-- generates their canonical shape; the columns below mirror what its
-- Postgres/Kysely adapter expects for those three tables). None of the three
-- get apply_tenant_rls: a session/account lookup happens before any tenant
-- scope is known for the request (explicit rabbit-hole call-out in the
-- item's shape) -- do not add tenant RLS to these out of a reflex to match
-- the rest of the schema.
--
-- Migration number note: the item's shape assumed "last existing is
-- 0012_contract_rate_rls.sql" and named this migration 0013. 0013 was taken
-- by 0013_grant_freight_app_to_connecting_role.sql (86e2v1qxz, landed after
-- this item was shaped) by the time this was built -- this is 0014, not a
-- drift from the shape's intent.
-- ---------------------------------------------------------------------------

ALTER TABLE app_user
  ADD COLUMN name text,
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN image text;

-- Backfill existing rows so anything already in app_user reads sensibly
-- through better-auth's schema (e.g. an admin tool listing users). Not a
-- correctness requirement of this item's ACs -- resolveAuthorizedTenantContext
-- never reads `name` -- just keeps the column from being NULL by accident
-- everywhere back-auth-created rows are the only ones that populate it.
UPDATE app_user SET name = COALESCE(full_name, split_part(email, '@', 1)) WHERE name IS NULL;

CREATE TABLE ba_session (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ba_session_user_id_idx ON ba_session(user_id);

CREATE TABLE ba_account (
  id                       text PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  id_token                 text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ba_account_user_id_idx ON ba_account(user_id);

CREATE TABLE ba_verification (
  id         text PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ba_verification_identifier_idx ON ba_verification(identifier);

-- 0010 granted full CRUD to freight_app over every table that existed at the
-- time it ran; these three tables are new, so they need the same grant
-- explicitly here (0010's loop is not dynamic/self-extending -- confirmed by
-- reading it before writing this).
GRANT SELECT, INSERT, UPDATE, DELETE ON ba_session, ba_account, ba_verification TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS ba_verification;
DROP TABLE IF EXISTS ba_account;
DROP TABLE IF EXISTS ba_session;
ALTER TABLE app_user
  DROP COLUMN IF EXISTS image,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS email_verified,
  DROP COLUMN IF EXISTS name;
