# Database backup & restore

Part of the client launch-readiness gate (`86e2zfk30`) — item 2, "Backups configured." This is a
documentation-level confirmation that a restore procedure exists, not a live restore rehearsal in
CI (the task's own scope: "a minimal runbook is sufficient for v1").

## Current status

Production backups status: NOT CONFIGURED

- **Development** (`freight-auditor-dev`) runs on a dedicated Neon Postgres instance (see
  `.github/workflows/deploy.yml`'s "Set vault name" step comment). Neon's own point-in-time
  recovery covers it; nothing additional is required there.
- **Production** has no `DATABASE_URL` secret provisioned yet (see the `migrate-database` job's
  comments in `.github/workflows/deploy.yml` — this is a real, current gap, not a hypothetical).
  This runbook is the standard the production instance must satisfy **before** it is provisioned
  and before a client is onboarded — it is normative, describing what must be true, not a report
  of an already-running backup job. The launch-readiness gate (item 2) reads the `Production
  backups status:` line above literally: it stays `NOT CONFIGURED` — and the gate stays
  NOT READY — until a production database actually exists with automated backups enabled, at
  which point this line must be updated to `CONFIRMED` alongside the provisioning work itself.

## Automated backups

Before a production database exists, it must be provisioned on a host with automated,
point-in-time-recoverable backups enabled by default (e.g. Neon, matching the dev instance;
Supabase and RDS are the other hosts this repo already treats as "managed" — see
`db.protected_db_hosts` in `.claude/clickup-build.config.json`). Confirm, at provisioning time:

- Automated daily (or better) backups are enabled.
- Point-in-time recovery (or equivalent) covers at least the last 7 days.
- The backup retention window is documented wherever the production connection string lives
  (the 1Password vault item, per this repo's `op://` convention).

## Restore procedure

1. Identify the target recovery point (timestamp, or the last known-good point before the
   incident).
2. Using the provider's restore/branch-from-point-in-time feature (e.g. Neon's branch-from-a-point
   feature, or the equivalent RDS/Supabase snapshot restore), create a new database instance at
   that recovery point. Do not restore in place over the live instance — restore to a new
   instance first, verify it, then cut over.
3. Verify the restored instance: run `npm run migrate -- up --no-check-order` against it to
   confirm it's at (or can reach) the expected migration head, and spot-check a handful of rows in
   a financial-boundary table (`audit_run`, `finding`, `recovery_event`) against known-good values.
4. Update the production `DATABASE_URL` secret (1Password, `op://` reference — never write the
   resolved value to disk, per this repo's secret-handling floor) to point at the restored
   instance.
5. Re-run the deploy workflow (`workflow_dispatch` on `Production`, or push) so the running
   container picks up the new connection string, then confirm `GET /health` reports
   `database: ok`.
6. Decommission the old (incident) instance only after the restored one has been live and healthy
   for a full deploy cycle.

## Scope

This is the v1 minimal procedure — sufficient to unblock the launch-readiness gate. It
deliberately excludes a scheduled restore-rehearsal drill in CI (out of scope per `86e2zfk30`'s
own Rabbit holes/No-gos) and legal/compliance retention policy (explicitly excluded per the
2026-09-02 Bridge decision on that task).
