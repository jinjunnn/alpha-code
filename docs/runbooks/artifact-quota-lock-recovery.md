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
and no-clobber restoration, plus a final holder-identity check immediately
before artifact commit. A process with write authority over the project's
`.alpha` directory can still replace paths in the last check-to-operation
window. Shared-volume hosts also require distinct `hostId` values; this lock is
not a distributed coordination protocol. Stop all finalizers and use the
controlled evidence-preserving procedure whenever ownership cannot be proven.
