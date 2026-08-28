-- Up Migration
-- P4.B.1: per-client payment-policy CONFIGURATION only. hold_then_approve
-- defaults true and is the platform default (§10): this table lets a client
-- be configured, never lets a payment actually flow -- enforcement is P4.B.2
-- (hold-then-approve), P4.B.3 (short-pay), P4.B.4 (do-not-pay), P4.B.7
-- (expired-approval escalation), none of which are implemented here.
CREATE TABLE client_payment_policy (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid NOT NULL UNIQUE REFERENCES client(id),
  hold_then_approve      boolean NOT NULL DEFAULT true,
  short_pay_enabled      boolean NOT NULL DEFAULT false,
  approval_expiry_hours  integer NOT NULL DEFAULT 72 CHECK (approval_expiry_hours > 0),
  configured_by          uuid NOT NULL REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

SELECT apply_tenant_rls('client_payment_policy', 'client_id');

-- Configuration is expected to change; unlike this repo's append-only
-- ledgers, GRANT the mutable policy columns plus updated_at (matches
-- workflow_instance's column-scoped shape from 0046). Never DELETE -- a
-- client always has exactly one row once configured; there is no "remove
-- the policy" operation, only "change it back to the default."
GRANT SELECT, INSERT ON client_payment_policy TO freight_app;
GRANT UPDATE (hold_then_approve, short_pay_enabled, approval_expiry_hours, updated_at) ON client_payment_policy TO freight_app;

-- Down Migration
REVOKE ALL ON client_payment_policy FROM freight_app;
DROP TABLE IF EXISTS client_payment_policy;
