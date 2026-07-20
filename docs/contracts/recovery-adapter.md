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
exception messages, or stacks. The injected logger receives only fixed metadata: the recovery code,
action when applicable, status, and a stable reason enum. Raw source plans, errors, and stacks never
cross that injection boundary. A logger throw or rejected logger promise is isolated and cannot
change the returned DTO or action control flow.

## Action result and idempotency

The exact branded `RecoveryPlan` object returned by `adaptRecoveryPlan` is the main-process incident
owner. Its identity is not serialized into the renderer DTO. A process-local `WeakMap` registry keys
shared action state by that owner, so rebuilding multiple action-adapter instances for the same plan
coalesces their submissions. A constructed, cloned, or deserialized DTO is not an incident owner and
is rejected at the action-adapter factory boundary. A newly observed incident requires a newly
adapted plan object; releasing the plan also permits its process-local state to be collected.

- An effect must return `{ applied: true }` before the adapter emits `RECOVERY_ACTION_APPLIED`.
  Resolving a `void` promise is not a success contract.
- Concurrent repeats of the same action share one effect. A repeat after application returns
  `RECOVERY_ACTION_ALREADY_APPLIED` with `applied: false`.
- After one action applies, a different action returns `RECOVERY_ACTION_CONFLICT` and has no effect.
- An unavailable action returns `RECOVERY_ACTION_UNAVAILABLE`; a different action submitted while
  another is in flight returns `RECOVERY_ACTION_BUSY`.
- A failed effect returns `RECOVERY_ACTION_FAILED` without its raw exception. Retry occurs only when
  both the problem and an explicit `{ applied: false, retryable: true }` effect result report it as
  retryable. An explicit `{ applied: false }` result has a known boundary and remains terminal only
  for that action when it is not retryable. A thrown exception has an unknown application boundary,
  terminates the whole incident, and makes every later different action return
  `RECOVERY_ACTION_CONFLICT` without running an effect. The original action continues to return its
  cached `RECOVERY_ACTION_FAILED` result.

## Surface fallback boundary

The current `SurfaceBoundary` still persists a crash record and then reloads into a legacy surface.
Owner decision C requires all five surfaces to become alpha-only, with region rebuild, fail-closed
handling, and boot Recovery instead. The legacy reload is therefore intentionally absent from the
adapter action enum and remains production behavior for the separate UI line to remove. Until that
line supplies a real replacement, a successfully saved surface crash is represented with no
executable action and `retryable: false`; the adapter must not claim that region rebuild exists.
