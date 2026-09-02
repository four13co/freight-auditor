-- Up Migration
-- P4.C.9: the carrier-response lifecycle after a dispute is sent --
-- accepted, rejected, partial, and closed. dispute_status (0002) only has
-- 'draft' | 'sent' | 'in_progress' | 'accepted' | 'rejected' | 'closed' --
-- no 'partial' value exists yet for a carrier that agrees to pay some but
-- not all of a disputed amount. Postgres enums only support additive
-- ALTER TYPE ... ADD VALUE, matching this repo's established
-- additive-schema convention (0017/0052 precedent).
ALTER TYPE dispute_status ADD VALUE 'partial';

-- accepted_amount records what the carrier agreed to pay on a 'partial'
-- resolution (in dispute.currency -- a partial acceptance is a fraction of
-- the SAME claimed amount, never a currency conversion, so no separate
-- currency column is needed). NULL for every other status, including a
-- full 'accepted' (which implies the full amount_claimed, not a distinct
-- recorded figure).
--
-- NOT created in the same transaction as the ADD VALUE above: PG17 forbids
-- referencing a just-added enum value inside the transaction that added
-- it. This column addition names no enum value at all, so it is safe here
-- (0052 precedent) -- the application code that writes 'partial' into this
-- column runs in a later, separate transaction at request time.
ALTER TABLE dispute ADD COLUMN accepted_amount numeric(18,4);

-- Down Migration
ALTER TABLE dispute DROP COLUMN accepted_amount;
-- Postgres has no DROP VALUE for enums; a real rollback would require
-- rebuilding the type across every dispute_status column -- destructive
-- and out of scope for a down migration, matching the documented no-op
-- this repo already established for 0017's/0052's enum additions.
