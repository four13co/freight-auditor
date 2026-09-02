-- Up Migration
-- 86e32tg6n: ingest-invoice.ts now categorizes production charges through the
-- real DB-backed crosswalk (resolveChargeCode) instead of the 4-entry
-- in-memory stub (stub-crosswalk.ts). The crosswalk table itself has carried
-- zero rows since its creation (migration 0004) -- wiring resolveChargeCode
-- in with no data behind it would quarantine every charge on every existing
-- carrier code (400/405/500/510), a regression versus the stub it replaces.
--
-- Seed those same four mappings as GLOBAL rows (client_id NULL, carrier_id
-- NULL, precedence_rank 1 -- the lowest rung of the §6.2 ladder) so an
-- invoice with no client- or carrier-specific override categorizes exactly
-- as it did under the stub. A client- or carrier-specific crosswalk row
-- (ranks 2-4) still overrides these per the existing precedence query.
INSERT INTO charge_code_crosswalk (client_id, carrier_id, source_code, canonical_category, precedence_rank)
VALUES
  (NULL, NULL, '400', 'LINEHAUL', 1),
  (NULL, NULL, '405', 'FUEL', 1),
  (NULL, NULL, '500', 'OCEAN_FREIGHT', 1),
  (NULL, NULL, '510', 'DOC_FEE', 1);

-- Down Migration
DELETE FROM charge_code_crosswalk
 WHERE client_id IS NULL AND carrier_id IS NULL
   AND precedence_rank = 1
   AND source_code IN ('400', '405', '500', '510');
