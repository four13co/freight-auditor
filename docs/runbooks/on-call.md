# On-call runbook (v1)

Part of the client launch-readiness gate (`86e2zfk30`) — item 4, "On-call runbook exists." A v1
runbook: who responds, and where to look first. Per the task's own scope, this repo's own
README pointers are sufficient for v1.

## Who responds

The repo owner (`greg@four13.co`) is the sole responder as of this writing — there is no rotation
yet. GitHub's default failure notification (email to the actor who triggered the workflow, and to
watchers per their notification settings) is the paging mechanism today; there is no dedicated
alerting channel (Slack/PagerDuty) wired up, and building one is out of scope for this task (see
`86e2zfk30`'s Rabbit holes: "these four concrete items are the whole scope").

## Where to look first

1. **`GET /health`** and **`GET /ready`** (`src/server/static-routes.ts`) — `/health` reports
   liveness plus dependency status (`database`, `object_store`); `/ready` additionally gates on
   both being `ok`. Either is a fast first check for "is the app up and can it reach its
   dependencies."
2. **The GitHub Actions run for `Deploy to CapRover`** (`.github/workflows/deploy.yml`) — the
   `post-deployment` job polls `/health` after every deploy (`scripts/post-deploy-healthcheck.mjs`)
   and automatically rolls back to the last known-good revision on failure
   (`scripts/rollback-deploy.mjs`). A failed run here is usually the first signal of a bad deploy,
   and the job log shows exactly which health check failed and whether rollback succeeded.
3. **CapRover's own dashboard** for the app in question — container logs and restart history live
   there; useful when `/health` itself is unreachable (container crash-looping) rather than
   reporting `database`/`object_store` failures.
4. **This repo's README** (`## Stack`, `## Commands`) for how the app is built and run locally, if
   reproducing an issue outside production is needed.

## Escalation

None yet — single responder. Revisit once a second person joins on-call rotation.
