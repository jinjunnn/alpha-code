---
title: Recovery adapter contract
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-20
review_after: 2027-01-16
---

# Recovery adapter contract

The desktop Recovery adapter is the only contract boundary that converts existing recovery plans,
actions, and results into renderer-safe values. It does not choose a database recovery algorithm,
restart the sidecar, mount Recovery UI, or implement a surface rebuild.

## Problem codes and actions

| Existing source state | Stable code | Exposed actions | Retryable |
| --- | --- | --- | --- |
| DbSafety `corrupt`, backup present | `RECOVERY_DATABASE_CORRUPT` | `restore-latest-backup`, `exit-app`, `continue-startup` | no |
| DbSafety `corrupt`, no backup | `RECOVERY_DATABASE_CORRUPT` | `exit-app`, `continue-startup` | no |
| DbSafety `db-ahead` | `RECOVERY_DATABASE_TOO_NEW` | `exit-app`, `backup-and-continue`, `continue-startup` | no |
| sidecar self-heal `give-up` | `RECOVERY_ENGINE_STOPPED` | `retry-engine` | yes |
| surface crash, failure record save failed | `RECOVERY_SURFACE_CRASHED` | `retry-failure-save` | yes |
| surface crash, failure record pending or saved | `RECOVERY_SURFACE_CRASHED` | none | no |

DbSafety `skip`, `proceed`, and `migrate-ahead`, plus sidecar self-heal `heal`, are not Recovery
problems and map to no DTO. The adapter never invents an action for them.

Every problem DTO contains exactly `code`, `category`, `actions`, and `retryable`. It must not
contain absolute paths, user/home names, backup file names, migration ids, surface ids, secrets,
exception messages, or stacks. Source details and action exceptions may be passed only to the local
logger supplied to the adapter.

## Action result and idempotency

One action-adapter instance owns one observed failure incident. A caller creates a new instance only
after observing a new incident.

- An effect must return `{ applied: true }` before the adapter emits `RECOVERY_ACTION_APPLIED`.
  Resolving a `void` promise is not a success contract.
- Concurrent repeats of the same action share one effect. A repeat after application returns
  `RECOVERY_ACTION_ALREADY_APPLIED` with `applied: false`.
- After one action applies, a different action returns `RECOVERY_ACTION_CONFLICT` and has no effect.
- An unavailable action returns `RECOVERY_ACTION_UNAVAILABLE`; a different action submitted while
  another is in flight returns `RECOVERY_ACTION_BUSY`.
- A failed effect returns `RECOVERY_ACTION_FAILED` without its raw exception. Retry occurs only when
  both the problem and an explicit `{ applied: false, retryable: true }` effect result report it as
  retryable. A thrown exception has an unknown application boundary and is therefore non-retryable.
  Non-retryable failures are cached, so a duplicate cannot repeat a partial side effect.

## Surface fallback boundary

The current `SurfaceBoundary` still persists a crash record and then reloads into a legacy surface.
Owner decision C requires all five surfaces to become alpha-only, with region rebuild, fail-closed
handling, and boot Recovery instead. The legacy reload is therefore intentionally absent from the
adapter action enum and remains production behavior for the separate UI line to remove. Until that
line supplies a real replacement, a successfully saved surface crash is represented with no
executable action and `retryable: false`; the adapter must not claim that region rebuild exists.
