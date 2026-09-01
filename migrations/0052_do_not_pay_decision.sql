-- Up Migration
-- P4.B.4: 'do_not_pay' is a distinct outcome from 'hold' -- hold is a
-- pending-review state (something else, e.g. an expired approval, resolves
-- it later); do_not_pay is a firm decision driven by a structural gate
-- failure (the invoice never reached SCORED). Postgres enums only support
-- additive ALTER TYPE ... ADD VALUE, matching this repo's established
-- additive-schema convention (0017 precedent).
ALTER TYPE payment_gate_action ADD VALUE 'do_not_pay';

-- Idempotency target: payment_gate_decision (0008) is append-only-granted
-- (INSERT+SELECT only, 0010) with no existing uniqueness, so a retried
-- decision call would otherwise write a second row silently. Scoped to
-- (client_id, audit_run_id, action) rather than just (client_id,
-- audit_run_id) because a later item may legitimately record more than one
-- ACTION kind against the same audit_run over its lifecycle (e.g. a hold
-- superseded by an approve) -- this constraint only prevents the SAME action
-- from being recorded twice for the same run, which is what this item's own
-- retry-safety needs.
--
-- NOT created in this same transaction as the ADD VALUE above: PG17 forbids
-- referencing a just-added enum value inside the transaction that added it.
-- This constraint names the column, not the 'do_not_pay' value, so it is
-- safe here; a value-specific partial index would not be.
ALTER TABLE payment_gate_decision
  ADD CONSTRAINT payment_gate_decision_run_action_uk UNIQUE (client_id, audit_run_id, action);

-- Down Migration
ALTER TABLE payment_gate_decision DROP CONSTRAINT payment_gate_decision_run_action_uk;
-- Postgres has no DROP VALUE for enums; a real rollback would require
-- rebuilding the type across every payment_gate_action column -- destructive
-- and out of scope for a down migration, matching the documented no-op this
-- repo already established for 0017's enum addition.
