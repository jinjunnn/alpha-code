---
title: Artifact quota lock recovery
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-18
---

# Artifact quota lock recovery

The managed-project artifact finalizer uses one primary lock at
`<project>/.alpha/artifact-quota.lock`. Normal recovery is automatic only when
the record is valid, its `hostId` identifies the local host, and the recorded
PID is conclusively dead. Recovered locks are preserved below
`<project>/.alpha/artifact-quota-stale/`.

Do not remove or rewrite a busy lock merely because it is old. A malformed
record, foreign-host record, live PID, or indeterminate liveness probe is
intentionally fail-closed.

## Automatic race convergence

Portable Node filesystem APIs cannot conditionally rename a path by its
previously observed `dev`/`ino`. Two dead-lock reclaimers can therefore both
validate the old primary before one of them creates a new primary. If the
later reclaimer moves that new lock, the post-move identity check detects the
mismatch, deletes the displaced copy from `artifact-quota-stale`, and returns
`artifact quota admission unavailable (project lock busy)` for that attempt.
It never restores the displaced lock.

The displaced holder checks ownership immediately before the artifact rename.
A missing or different primary permanently marks that handle as having lost
ownership and aborts the finalize with
`artifact quota admission unavailable (project lock ownership lost)`. The
primary remains absent, so the next retry can create a fresh lock normally.
This race can cause one retryable finalization failure but cannot leave a
live-PID lock whose finalizer has already exited.

If the displaced copy cannot be deleted, the affected attempt fails with
`artifact quota admission unavailable (displaced lock cleanup failed)`. The
copy is not authoritative as a primary, but its identity could not be cleaned
up automatically. Stop all finalizers and preserve or remove that residual
copy only under the controlled procedure below; do not infer ownership from
its location in `artifact-quota-stale`.

## Controlled manual recovery

Use this procedure only after repeated finalization attempts return
`artifact quota admission unavailable (project lock busy)` and automatic local
dead-PID recovery cannot proceed.

1. Stop every alpha-code process or other artifact finalizer that can write the
   affected managed project. If the project is on a shared volume, confirm this
   on every host. If that cannot be proven, leave the lock in place.
2. Preserve diagnostics before mutation: record the lock's `ls -li` identity,
   owner/mode and raw holder record. For a valid local record, independently
   confirm the PID is absent; PID reuse is treated as live and requires the
   all-finalizers-stopped condition above.
3. Create `<project>/.alpha/artifact-quota-stale/` if necessary, then move the
   primary lock to a unique `artifact-quota-manual-<timestamp>-<nonce>.lock`
   name in that directory with a no-clobber operation. Never delete the lock or
   overwrite existing evidence.
4. Confirm `artifact-quota.lock` is absent, restart one finalizer, and retry the
   download. The next admission recreates the primary lock with a fresh
   `{pid, hostId, nonce, startedAt}` record and charges any already-final file
   from the disk scan.

Uniquely named `.part` files are not committed usage. Leave them in place while
diagnosing the writer; normal failed-download cleanup may remove them. Do not
rename a `.part` directly to its final name outside the quota finalizer.

## Residual boundary

Portable Node filesystem APIs do not provide a conditional rename by
`dev`/`ino`. The implementation therefore narrows the remaining pathname race
with pre-rename identity validation, post-rename archived-identity validation
and deletion of a proven displaced copy, plus a final holder-identity check
immediately before artifact commit. There is deliberately no restoration
step. A process with write authority over the project's `.alpha` directory can
still replace paths in the last check-to-operation window. Shared-volume hosts
also require distinct `hostId` values; this lock is not a distributed
coordination protocol. Stop all finalizers and use the controlled
evidence-preserving procedure whenever ownership or a residual lock cannot be
proven.
