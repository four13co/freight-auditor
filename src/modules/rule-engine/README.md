# rule-engine module

The declarative predicate AST + interpreter (Master Spec §3.2) rules are
evaluated with, plus the rule lifecycle state machine built on top of it.

- `ast.ts` defines the declarative predicate AST rules are stored as
  (`rule_version.ast`); `interpreter.ts` is the pure, owned interpreter that
  evaluates it — no `eval`, no I/O, no `Date.now()`/randomness, total (every
  node resolves to a value or an explicit `UNASSESSABLE`, never throws).
  Both are the audit engine's core: used throughout `evaluator/`,
  `contracts/`, `discovery/`, and `rubric-resolver/`.
- `transition-rule-lifecycle.ts` enforces the `rule_version.lifecycle_state`
  state machine (`PROPOSED → SHADOW → ACTIVE → DEPRECATED`, or
  `→ QUARANTINED` from PROPOSED/SHADOW/ACTIVE); reachable via
  `src/server/rule-governance-routes.ts`'s ratify/activate routes.
  `promote-shadow-rule.ts` gates the SHADOW→ACTIVE transition on a passing
  `rule_backtest` row, also reachable there.
- `record-human-override-reversal.ts` is the write path for a human
  reversing a rule's verdict (`human_override`, append-only); it calls
  `quarantine-on-reversal.ts`, which auto-quarantines a rule once its
  reversal count crosses the threshold `promotion-policy.ts` resolves for
  that rule type (`n1Confirm`/`n2Confirm`/`maxReversals`). Reachable via
  `src/server/findings-routes.ts`'s finding-reversal route.
- **Deferred: built, tested, zero production callers.** `persist-backtest.ts`
  writes a `rule_backtest` row recording a corpus run's pass/regression
  result — nothing in production calls it, only its own unit test. Since
  `promote-shadow-rule.ts` requires a passing `rule_backtest` row to exist
  before it will promote SHADOW to ACTIVE, no rule can actually be promoted
  through this codebase's own surface today until something calls
  `persistBacktest` after running a corpus. **What unblocks it:** a
  route or job that runs a rule version's backtest corpus and persists the
  result via `persistBacktest` — the corpus-execution side of this is not
  itself part of this module.
