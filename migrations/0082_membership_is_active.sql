-- Up Migration
-- ---------------------------------------------------------------------------
-- 0082 (86e3a75mf): per-membership enable/disable. The admin Users page's
-- Status column previously proxied client.is_active (tenant-level) --
-- membership had no is_active column at all, so there was no way to block
-- one user's access to one tenant without deactivating the whole tenant or
-- deleting the membership outright. Additive, defaults every existing row to
-- active (true) so no prior access is silently revoked by this migration.
--
-- Deliberately independent of app_user.is_active (global, every tenant) and
-- client.is_active (tenant-level) -- this flag scopes to exactly one
-- membership row, per this item's own Solution precedence note.
-- ---------------------------------------------------------------------------
ALTER TABLE membership ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- Down Migration
ALTER TABLE membership DROP COLUMN IF EXISTS is_active;
