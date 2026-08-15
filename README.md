# freight-auditor

Freight Audit Platform — see the Master Specification in ClickUp (`h62ja-635917`) for the
architecture (three-tier rubric → criterion → rule, gate→score pipeline, hardening ladder).

This is the **project skeleton** (scaffolding item `86e24cy2d`). It stands up the runtime,
build, and test toolchain the later phases depend on. No business logic yet.

## Stack

- **Node 24** (`.nvmrc`), TypeScript (ESM, strict), builds to `dist/`.
- **Fastify** HTTP server.
- **Postgres** via `pg`; migrations via `node-pg-migrate`.
- **pg-boss** for the durable job queue (queue-in-Postgres — no Redis).
- **decimal.js** for money (never IEEE float — spec §3.2).
- **Vitest** for unit + e2e.

## Commands

```bash
npm ci
npm run build      # tsc -> dist/server/index.js (matches Dockerfile CMD)
npm start          # node dist/server/index.js
npm run dev        # tsx watch (local)
npm test           # vitest (unit + e2e)
npm run lint
npm run typecheck
```

Local dev with secrets: `op run --env-file=.env.op -- npm run dev` (references only; never
write a populated `.env` locally — CI resolves secrets directly into each step's subprocess env
via `op run --env-file=...`, never to disk or `$GITHUB_ENV`; see `.github/workflows/deploy.yml`).

## Decisions (ADR notes)

- **Fastify over NestJS.** The spec (§2.1) allows either for the modular monolith. Chose
  Fastify: lighter, no DI-graph ceremony, and module boundaries are enforced by folder/import
  discipline (`src/modules/*`) rather than a framework. Revisit if DI/interceptor needs grow.
- **node-pg-migrate over drizzle-kit.** SQL-first migrations, append-only friendly (the spec's
  financial-boundary tables need INSERT-only grants and raw DDL like GiST exclusion constraints),
  and no ORM lock-in on the query side. `pg` is the driver.
- **Build layout:** `tsconfig.build.json` sets `rootDir: src` so `src/server/index.ts` compiles
  to `dist/server/index.js` — the path the existing `Dockerfile` `CMD` expects.

## Data model (migrations)

The canonical Postgres schema lives in `migrations/` (SQL, `node-pg-migrate`), unifying the
Master Spec §6 audit spine with the TransportDocument extraction schema (as cited evidence).

```bash
# against an ephemeral local Postgres (never a protected host)
DATABASE_URL=postgresql://user:pw@127.0.0.1:PORT/db npm run migrate up
DATABASE_URL=postgresql://user:pw@127.0.0.1:PORT/db npm run test:db   # DB contract tests
```

Key invariants baked into the schema:

- **Tenant isolation is structural** — every tenant table has `FORCE ROW LEVEL SECURITY` with a
  policy keyed on the `app.current_client_ids` / `app.is_internal` GUCs (set per request via
  `SET LOCAL` in Phase 0). The app connects as the non-superuser `freight_app` role so the
  policy binds. Shared catalog rows (tenant column `NULL`) read across tenants.
- **Append-only at the financial boundary** — the §11 ledger tables (`audit_event`,
  `rule_version`, `contract_version`, `variance_finding`'s status events, `recovery_event`, …)
  grant `freight_app` only `INSERT`/`SELECT`. No UPDATE/DELETE grant exists to revoke.
- **Temporal resolution** — `contract_version` carries a GiST `EXCLUDE` constraint so exactly one
  version is applicable per `(contract, ship-date)`.
- **Money** is `numeric(18,4)` + per-row `currency char(3)`, never pre-converted.
- **Transport documents** are stored as `jsonb` (full extracted structure) + typed projection
  columns for the fields that need indexing/citation — see the header comment in
  `migrations/0007_shipments_invoices_transport.sql` for the jsonb-vs-normalized rationale.

> uuid PKs default to `gen_random_uuid()` (v4); swap the default to `uuidv7()` on PG18.
> `criterion_key` governance (§14 #9) is deferred — modeled as a stable string + append-only
> `criterion_alias` for renames.

## Dev dashboard setup

The dashboard (`web/`) authenticates its API calls with fixed dev-mode headers
(`x-client-id`/`x-user-id` — see `web/src/lib/api.ts`), which must be backed by a real
`membership` row or every `/api/findings*` call 401s (tenant isolation checks membership, not
just header presence). **After running migrations against a fresh DB, seed that row once:**

```bash
DATABASE_URL=postgresql://user:pw@127.0.0.1:PORT/db npm run seed:dev
```

This is a one-time manual step per environment/DB — not automated into CI or `deploy.yml`
(seeding dev-fixture tenant data from CI would collide with `guard-protected-db.mjs`'s
protected-host guard; this is fixture data, not schema DDL). Safe to re-run: it's idempotent
(`ON CONFLICT DO NOTHING` throughout, see `scripts/seed-dev-tenant.mjs`).

## Module map (spec §2.2)

`src/modules/` holds a placeholder folder per spec module: ingestion, contracts,
rubric-resolver, rule-engine, evaluator, rate-engine, hardening, discovery, audit-engine,
findings, disputes, payment-gate, claims, reference-data, identity, audit-ledger. All empty
until their phase.
