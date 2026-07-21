---
title: Recovery adapter contract
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Recovery adapter contract

The desktop Recovery adapter is the only contract boundary that converts existing recovery plans,
actions, and results into renderer-safe values. It does not choose a database recovery algorithm,
restart the sidecar, mount Recovery UI, or implement a surface rebuild.

## Problem codes and actions

| Existing source state                          | Stable code                 | Exposed actions                                         | Retryable |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------- | --------- |
| DbSafety `corrupt`, backup present             | `RECOVERY_DATABASE_CORRUPT` | `restore-latest-backup`, `exit-app`, `continue-startup` | no        |
| DbSafety `corrupt`, no backup                  | `RECOVERY_DATABASE_CORRUPT` | `exit-app`, `continue-startup`                          | no        |
| DbSafety `db-ahead`                            | `RECOVERY_DATABASE_TOO_NEW` | `exit-app`, `backup-and-continue`, `continue-startup`   | no        |
| sidecar self-heal `give-up`                    | `RECOVERY_ENGINE_STOPPED`   | `retry-engine`                                          | yes       |
| surface crash, failure record save failed      | `RECOVERY_SURFACE_CRASHED`  | `retry-failure-save`                                    | yes       |
| surface crash, failure record pending or saved | `RECOVERY_SURFACE_CRASHED`  | none                                                    | no        |

DbSafety `skip`, `proceed`, and `migrate-ahead`, plus sidecar self-heal `heal`, are not Recovery
problems and map to no DTO. The adapter never invents an action for them.

Every problem DTO contains exactly `code`, `category`, `actions`, and `retryable`. It must not
contain absolute paths, user/home names, backup file names, migration ids, surface ids, secrets,
exception messages, or stacks. The injected logger receives only fixed metadata: the recovery code,
action when applicable, status, and a stable reason enum. Raw source plans, errors, and stacks never
cross that injection boundary. A logger throw or rejected logger promise is isolated and cannot
change the returned DTO or action control flow.

## Action result and idempotency

The main-process source plan object is the incident owner: the `PreflightPlan` for database recovery,
the `SelfHealPlan` for engine recovery, and the surface source object for surface recovery. A
process-local `WeakMap` memoizes the first eligible adaptation by that source object together with
its shared action state. Repeated calls with the same source plan therefore return the exact same
`RecoveryPlan` DTO, and every action adapter created from those calls converges on the same state;
callers do not need to coordinate a single adaptation. The wrapper passed for a database or engine
source is not the key and may be rebuilt without splitting the incident.

Source identity and the registry are not serialized into the renderer DTO. A reverse process-local
ownership map admits only the exact memoized DTO at the action-adapter factory boundary, so a
constructed, cloned, or deserialized DTO is rejected. Releasing the source plan and DTO permits their
process-local state to be collected. A source object reconstructed after serialization or in another
process has new identity and is outside this process-local guarantee.

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

## Main incident ownership and Alpha-only surface recovery

The renderer supplies a per-boundary crash nonce only for retry reconciliation. Main owns the actual
incident identifier, creates exactly one surface source object after the first persistence attempt,
and stores the exact adapted plan plus action adapter in a process-local registry. Repeated IPC
admission for the same sender, nonce, and surface returns the same main-side wire object; a nonce
reused for another surface is rejected. This keeps `retry-failure-save` effect-once even though every
IPC response is deserialized into a fresh renderer object.

`SurfaceBoundary` never sends raw exception text and never reloads a legacy surface. Persisted
diagnostics contain only `RECOVERY_SURFACE_CRASHED`, the app version, the surface key used by the
main-owned store, and a timestamp. The renderer sees only the opaque incident ID and the adapter DTO.
A successfully saved surface crash has no executable action and remains isolated; a failed save may
offer only `retry-failure-save`. The adapter still does not claim that region rebuild exists.
