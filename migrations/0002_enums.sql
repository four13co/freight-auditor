-- Up Migration
-- ---------------------------------------------------------------------------
-- 0002: enumerated types. Centralized so every table references the same
-- canonical set. Enums that the Master Spec flags as a DRAFT taxonomy
-- (§14 #8 rule_type) are modeled as enums for now but noted as tunable.
-- ---------------------------------------------------------------------------

-- Tenancy / identity
CREATE TYPE membership_role AS ENUM ('analyst', 'lead', 'client_viewer', 'client_admin');
CREATE TYPE actor_kind      AS ENUM ('analyst', 'ai', 'system');

-- Transport documents (evidence) — mirrors the TransportDocument JSON Schema
CREATE TYPE transport_mode      AS ENUM ('OCEAN', 'AIR', 'MULTIMODAL', 'ROAD', 'RAIL');
CREATE TYPE transport_doc_type  AS ENUM (
  'MASTER_BILL_OF_LADING', 'HOUSE_BILL_OF_LADING', 'SEA_WAYBILL',
  'MASTER_AIR_WAYBILL', 'HOUSE_AIR_WAYBILL', 'MULTIMODAL_TRANSPORT_BILL', 'EXPRESS_BILL'
);

-- Reference data
CREATE TYPE carrier_type AS ENUM ('OCEAN_LINE', 'AIRLINE', 'NVOCC', 'FREIGHT_FORWARDER', 'CONSOLIDATOR');

-- Rubric / criterion / rule
CREATE TYPE criterion_kind    AS ENUM ('GATING', 'SCORING');
CREATE TYPE rubric_tier       AS ENUM ('STANDARD', 'CLIENT', 'CONTRACT');
CREATE TYPE override_verb     AS ENUM ('INHERIT', 'ADD', 'REPLACE', 'TIGHTEN', 'EXEMPT');
CREATE TYPE criterion_rule_role AS ENUM ('PRIMARY', 'GUARD', 'FALLBACK');
CREATE TYPE rule_combine      AS ENUM ('ALL_PASS', 'ANY_PASS', 'FIRST_APPLICABLE', 'SUM_VARIANCE');
CREATE TYPE unassessable_policy AS ENUM ('TREAT_AS_PASS', 'TREAT_AS_FAIL', 'TREAT_AS_UNASSESSABLE', 'BLOCK_GATE');

-- rule_type: Master Spec §14 #8 marks this a DRAFT taxonomy — tunable enum.
CREATE TYPE rule_type AS ENUM (
  'STRUCTURAL', 'INTRA_LINE', 'CROSS_REFERENCE', 'CONTRACT_CONFORMANCE',
  'EXTERNAL_REFERENCE', 'CROSS_DOCUMENT', 'POLICY_ELIGIBILITY'
);

-- Hardness gradient (§1.2) and lifecycle (§4)
CREATE TYPE rule_hardness  AS ENUM ('HUMAN_INPUT', 'AI_CANON', 'AI_DOCS', 'FIRM_RULE');
CREATE TYPE rule_lifecycle AS ENUM ('PROPOSED', 'SHADOW', 'ACTIVE', 'DEPRECATED', 'QUARANTINED');
CREATE TYPE rule_emits     AS ENUM ('PASS_FAIL', 'DOLLAR_VARIANCE');
CREATE TYPE promotion_direction AS ENUM ('PROMOTE', 'DEMOTE');

-- Invoices / charges
CREATE TYPE transaction_set AS ENUM ('210', '310');

-- Audit run outcomes (§5.4)
CREATE TYPE audit_outcome AS ENUM ('REJECTED_REWORK', 'NEEDS_INFO', 'SCORED', 'DISCOVERY_PENDING');

-- Findings
CREATE TYPE charge_finding_result AS ENUM ('CONFORMED', 'VARIANCE', 'UNASSESSABLE');
CREATE TYPE variance_status AS ENUM (
  'open', 'in_review', 'accepted', 'waived',
  'queued_for_dispute', 'disputed', 'recovered', 'written_off', 'closed'
);
CREATE TYPE variance_direction AS ENUM ('OVERCHARGE', 'UNDERCHARGE', 'INTEGRITY_ONLY');

-- Outputs
CREATE TYPE dispute_status AS ENUM ('draft', 'sent', 'in_progress', 'accepted', 'rejected', 'closed');
CREATE TYPE payment_gate_action AS ENUM ('approve', 'hold', 'short_pay');

-- Commercial references + extraction
CREATE TYPE commercial_ref_type AS ENUM ('INVOICE', 'SHIPPING_BILL', 'PII', 'PURCHASE_ORDER', 'PACKING_LIST');
CREATE TYPE answer_source AS ENUM ('read_from_doc', 'analyst_knowledge', 'carrier_confirmed');

-- Down Migration
DROP TYPE IF EXISTS answer_source;
DROP TYPE IF EXISTS commercial_ref_type;
DROP TYPE IF EXISTS payment_gate_action;
DROP TYPE IF EXISTS dispute_status;
DROP TYPE IF EXISTS variance_direction;
DROP TYPE IF EXISTS variance_status;
DROP TYPE IF EXISTS charge_finding_result;
DROP TYPE IF EXISTS audit_outcome;
DROP TYPE IF EXISTS transaction_set;
DROP TYPE IF EXISTS promotion_direction;
DROP TYPE IF EXISTS rule_emits;
DROP TYPE IF EXISTS rule_lifecycle;
DROP TYPE IF EXISTS rule_hardness;
DROP TYPE IF EXISTS rule_type;
DROP TYPE IF EXISTS unassessable_policy;
DROP TYPE IF EXISTS rule_combine;
DROP TYPE IF EXISTS criterion_rule_role;
DROP TYPE IF EXISTS override_verb;
DROP TYPE IF EXISTS rubric_tier;
DROP TYPE IF EXISTS criterion_kind;
DROP TYPE IF EXISTS carrier_type;
DROP TYPE IF EXISTS transport_doc_type;
DROP TYPE IF EXISTS transport_mode;
DROP TYPE IF EXISTS actor_kind;
DROP TYPE IF EXISTS membership_role;
