-- Up Migration
-- 86e320pkc: per-Customer (bank) white-labeling configuration -- a custom
-- domain plus a logo and color scheme. CONFIGURATION only, same posture as
-- 0058's client_payment_policy: this table lets a Customer be configured,
-- it does not itself serve anything -- resolve-branding-by-domain.ts (the
-- read path GET /api/branding uses) is what turns a row here into a
-- rendered experience.
--
-- One row per client (UNIQUE client_id) and one row per domain (UNIQUE
-- domain) -- a domain must resolve to exactly one Customer, and a Customer
-- has at most one active domain/branding configuration.
CREATE TABLE customer_branding (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL UNIQUE REFERENCES client(id),
  domain          text NOT NULL UNIQUE,
  logo_url        text NOT NULL,
  primary_color   text NOT NULL,
  secondary_color text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

SELECT apply_tenant_rls('customer_branding', 'client_id');

-- Domain -> Customer resolution (resolve-branding-by-domain.ts) runs BEFORE
-- any tenant scope exists for the request -- exactly like tenant-auth.ts's
-- membership lookup -- so the read path always uses the internal scope,
-- never a per-client one. This index is what makes that lookup a single
-- indexed equality scan rather than a sequential scan under FORCE RLS.
CREATE INDEX customer_branding_domain_idx ON customer_branding (domain);

-- Configuration is expected to change (same shape as 0058's
-- client_payment_policy): GRANT the mutable columns plus updated_at. Never
-- DELETE -- a Customer always has at most one row, there is no "remove
-- branding" operation, only "reconfigure it."
GRANT SELECT, INSERT ON customer_branding TO freight_app;
GRANT UPDATE (domain, logo_url, primary_color, secondary_color, updated_at) ON customer_branding TO freight_app;

-- Down Migration
REVOKE ALL ON customer_branding FROM freight_app;
DROP TABLE IF EXISTS customer_branding;
