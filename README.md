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
write a populated `.env` locally — CI uses `.env.template` + `op inject`).

## Decisions (ADR notes)

- **Fastify over NestJS.** The spec (§2.1) allows either for the modular monolith. Chose
  Fastify: lighter, no DI-graph ceremony, and module boundaries are enforced by folder/import
  discipline (`src/modules/*`) rather than a framework. Revisit if DI/interceptor needs grow.
- **node-pg-migrate over drizzle-kit.** SQL-first migrations, append-only friendly (the spec's
  financial-boundary tables need INSERT-only grants and raw DDL like GiST exclusion constraints),
  and no ORM lock-in on the query side. `pg` is the driver.
- **Build layout:** `tsconfig.build.json` sets `rootDir: src` so `src/server/index.ts` compiles
  to `dist/server/index.js` — the path the existing `Dockerfile` `CMD` expects.

## Module map (spec §2.2)

`src/modules/` holds a placeholder folder per spec module: ingestion, contracts,
rubric-resolver, rule-engine, evaluator, rate-engine, hardening, discovery, audit-engine,
findings, disputes, payment-gate, claims, reference-data, identity, audit-ledger. All empty
until their phase.
