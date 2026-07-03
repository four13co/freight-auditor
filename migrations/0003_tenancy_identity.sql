-- Up Migration
-- ---------------------------------------------------------------------------
-- 0003: tenancy & identity (Master Spec §6.1).
-- `client` is the tenant root. Every tenant-scoped table downstream carries
-- client_id and (0009) an RLS policy keyed on it.
-- ---------------------------------------------------------------------------

CREATE TABLE client (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  full_name   text,
  is_internal boolean NOT NULL DEFAULT false,  -- internal analyst vs client user
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  client_id  uuid NOT NULL REFERENCES client(id),
  role       membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

-- Composite indexes LEAD with the tenant key (§6.10).
CREATE INDEX membership_client_user_idx ON membership (client_id, user_id);

-- Down Migration
DROP TABLE IF EXISTS membership;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS client;
