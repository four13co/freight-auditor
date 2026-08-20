-- Up Migration
-- ---------------------------------------------------------------------------
-- 0015: better-auth passkey support (86e2v1bf1) + the account.issuer column
-- better-auth 1.7.x's account model added between 0014's better-auth
-- pinned version (1.6.29) and this item's required version (^1.7.1, per
-- @better-auth/passkey's peer dependency).
--
-- issuer column (ba_account):
-- better-auth 1.7.x's core account schema (@better-auth/core's
-- accountSchema) added `issuer: z.string()` -- required, not nullish, unlike
-- every other new-token-ish field on that model (accessToken/refreshToken/
-- idToken are all .nullish()). Confirmed via the package's own schema
-- source (node_modules/@better-auth/core/dist/db/schema/account.mjs) and via
-- an actual reproduction against a fresh ephemeral DB: sign-up failed with
-- "column issuer of relation ba_account does not exist" once better-auth
-- was bumped to 1.7.1, before this migration existed. better-auth's own
-- sign-up path (api/routes/sign-up.mjs) auto-populates this value via
-- createLocalAccountIssuer("credential") for the email/password provider
-- this app uses -- no config change needed in src/auth/better-auth.ts,
-- only the column itself. Nullable at the DB level (not NOT NULL) since
-- 0014's app_user/ba_account rows predate this column and better-auth
-- itself, not this migration, is what always supplies a value on write.
--
-- Backfill: reproduced against the ephemeral DB that a NULL issuer on an
-- EXISTING ba_account row (i.e. any account created under 1.6.29, before
-- this migration ran) fully locks that user out of sign-in -- better-auth's
-- own account lookup filters on issuer and returns "User not found"/401 for
-- a NULL match, not a graceful fallback. createLocalAccountIssuer('credential')
-- (the exact value better-auth's own sign-up path would have written had
-- this column existed at signup time) is `local:${encodeURIComponent(
-- providerId)}` = 'local:credential' for this app's only provider (verified:
-- every ba_account row in this DB has provider_id = 'credential', since
-- emailAndPassword is the only auth method configured). Every environment
-- this migration runs against started under better-auth 1.6.29 (this repo's
-- pinned version since 0014), so this predicate covers every real row, not
-- a guessed special case.
--
-- passkey table:
-- New table for @better-auth/passkey's passkey model. Column list and
-- required/optional split taken directly from the plugin's own schema
-- definition (node_modules/@better-auth/passkey/dist/index.mjs's exported
-- `schema` constant), not inferred -- same verification standard 0014 used
-- for ba_session/ba_account/ba_verification. userId references app_user
-- (better-auth's `user` model is mapped to app_user, per 0014). No RLS: a
-- passkey lookup, like a session/account lookup, happens before any tenant
-- scope is known for the request (same rabbit-hole this repo's other
-- better-auth tables already call out) -- do not add tenant RLS here.
-- ---------------------------------------------------------------------------

ALTER TABLE ba_account ADD COLUMN issuer text;

UPDATE ba_account SET issuer = 'local:credential' WHERE issuer IS NULL AND provider_id = 'credential';

CREATE TABLE passkey (
  id            text PRIMARY KEY,
  name          text,
  public_key    text NOT NULL,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  counter       integer NOT NULL,
  device_type   text NOT NULL,
  backed_up     boolean NOT NULL,
  transports    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  aaguid        text
);

CREATE INDEX passkey_user_id_idx ON passkey(user_id);
CREATE INDEX passkey_credential_id_idx ON passkey(credential_id);

-- 0010's grant loop granted every table that existed at the time it ran;
-- passkey is new, so it needs the same grant explicitly here (0014's
-- precedent for ba_session/ba_account/ba_verification -- confirmed by
-- reading 0010 before writing this, its loop is not self-extending).
GRANT SELECT, INSERT, UPDATE, DELETE ON passkey TO freight_app;

-- Down Migration
REVOKE SELECT, INSERT, UPDATE, DELETE ON passkey FROM freight_app;
DROP TABLE passkey;
ALTER TABLE ba_account DROP COLUMN issuer;
