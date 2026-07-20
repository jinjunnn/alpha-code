---
title: Artifact quota reservation recovery
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-18
---

# Artifact quota reservation recovery

Each managed-project artifact finalization attempt owns one immutable file at
`<project>/.alpha/runs/<run>/reservations/<startedAt>-<uuid>.json`. Its record is
`{pid, machineId, declaredBytes, startedAt, uuid}`. `startedAt` is sortable but
is sourced from millisecond wall-clock time. The finalizer counts all readable
reservations before scanning committed final files, so a residual
reservation reduces available run and project capacity without making an
uncommitted `.part` visible as an artifact.

`machineId` is the random UUID persisted once at
`<userData>/artifact-quota-machine-id`; it is not a hostname. Do not copy,
replace, or regenerate this file as a recovery action. If it is unreadable,
malformed, symlinked, or group/world-accessible, admission fails closed and the
identity must be repaired from a trusted backup or by the product owner.

Do not remove or rewrite a reservation merely because it is old. Age is not a
liveness signal. A foreign-machine record, malformed record, live PID, or
indeterminate PID probe is intentionally fail-closed.

This mechanism is supported only on local filesystems. The stable
`unsupported-filesystem` error means `userData` or the project artifact root is
not on the macOS filesystem-type whitelist: only `apfs` and `hfs` are accepted.
The rejection includes all FUSE types (`macfuse`, `osxfuse`, and `fuse.*`),
`nfs`, `smbfs`, `afpfs`, `webdav`, and every unknown type, even if its mount
options contain `local`. Move both roots to APFS or HFS volumes and retry; do
not work around the check by manually renaming `.part` files or deleting
reservations. Stable `disk` with detail `filesystem locality unavailable`
means `realpath` failed, `/sbin/mount` failed or timed out, its output was
malformed, or no owning mount point could be identified. Confirm the root is
available, inspect `/sbin/mount` for the resolved root's actual mount point,
repair the mount/OS command failure, restart the desktop, and retry. Do not
override the detector or treat an unreadable type as local. NFS/SMB cache
tuning is outside this runbook because shared volumes are not a supported
deployment.

## Automatic convergence

An active owner deletes only its own UUID-named reservation after either
yielding or failing before commit. After a successful final rename it also
deletes that same path after confirming its exact content and fd/path identity.

When combined usage exceeds a limit, conflicting reservations are ordered by
`(startedAt, uuid)`. A greater key observes the smaller key, deletes only its
own reservation, and returns
`artifact quota admission yielded to an earlier reservation`. The minimum key
ignores strictly greater reservations during its second quota calculation and
continues when committed usage plus its own declaration fits. It performs fresh
reservation-then-committed rescans before final rename until every greater
conflict has either deleted its reservation while yielding or exposed a
committed final file. Rescans use asynchronous directory reads and stats,
explicitly yield every 32 visited entries, and wait no more than 20 ms between
rounds. Each reservation-then-committed scan is capped at 250 ms and 10,000
entries. Convergence terminates after at most 5 seconds or 250 rounds, checks
the deadline on both sides of every scan, and clips each scan to the remaining
global time. The nominal per-round bounds alone are
`250 × (20 ms + 250 ms) = 67.5 s`, so the clipped 5-second deadline is the
dominant application bound. Normal event-loop timer scheduling may add jitter,
but no synchronous full-project walk extends the wait. Any bound returns stable
`retryable`; it never admits or waits forever. A smaller key that appears after
a greater key's first decision therefore cannot preempt an unseen commit; it
reevaluates the newly committed bytes. Retrying a yielded or `retryable`
download creates a new owner-unique reservation and rescans current disk truth.

The retryable detail identifies the exhausted bound:

- `reservation convergence timed out` means the global 5-second budget ended;
- `reservation convergence round limit reached` means 250 fast rounds ended;
- `quota scan timed out` means one scan reached its 250 ms independent cap; and
- `quota scan entry limit reached` means one scan visited more than 10,000
  entries.

For the first three, retry after other active downloads settle and inspect local
disk latency if the error repeats. For the entry cap, use supported artifact
removal/export flows to reduce managed run contents before retrying. Never
delete or rewrite reservation files merely to get below a scan bound.

A scan may lazily delete somebody else's residual reservation only when both of
these facts are conclusive:

1. `machineId` exactly matches the persistent local installation identity; and
2. probing the recorded PID returns `ESRCH`.

`EPERM` proves the process must be treated as live. Any other probe result is
indeterminate and does not authorize cleanup. Even after a successful lazy
unlink, the scanner keeps that declaration charged for its current decision;
only a later full scan observes its absence. Failure to unlink a proven-dead
reservation also leaves its `declaredBytes` charged and does not authorize
mutation of a different path.

Immediately before final rename, every owner reopens and compares its own
reservation's exact content and fd/path `dev`/`ino`. Missing or changed state
returns `retryable`. Consequently, a live owner mistakenly classified dead
cannot silently commit after its reservation is removed; the owner aborts and
its unique `.part` is cleaned. The opposite PID error—treating a dead owner as
live—only preserves conservative quota charge. PID reuse is therefore a
capacity/retry concern, not an over-admission path.

## Crash diagnosis

A crash has only conservative quota effects:

- before final rename: the reservation remains charged and the uniquely named
  `.part` remains excluded from committed usage;
- after final rename but before reservation deletion: both the final file and
  reservation are charged until dead-PID cleanup; and
- after reservation deletion: the final file alone is charged by the next disk
  scan.

For repeated `over-limit` yields, `retryable`, or
`artifact quota admission unavailable (...)`, inspect the affected run's
`reservations/` directory without changing it. Record each
filename, raw record, owner/mode, `machineId`, and PID probe result. A
reservation record intentionally does not contain a target pathname, so do not
claim that a particular final file matches it from the record alone. Correlate
with process logs and timestamps only as diagnostic evidence. Do not rename a
`.part` directly to its final name outside the quota finalizer.

To trigger safe cleanup, retry one finalization in the same desktop
installation. The scan will remove records whose local PID is conclusively dead
and will leave all others charged. If the originating installation is
unavailable, the PID is live or indeterminate, or the record is malformed,
preserve the reservation and treat the reduced capacity as the safe state. Do
not move it to an evidence directory
or replace it with a repaired record; ownership cannot be reconstructed from a
pathname mutation.

## Residual boundary

The mechanism has no shared admission file, recovery directory, restoration
step, heartbeat, coordination process, or third-party filesystem primitive.
Every normal create/delete targets the caller's UUID-named reservation; final
commit renames the caller's unique `.part`; the sole cross-owner deletion is a
same-machine reservation whose PID is conclusively dead. Final rename may
replace an existing run-owned target; `removeArtifact` may unlink its selected
manifest-owned final; and downloader failure cleanup may remove only the
invocation's `O_EXCL`-created `.part`. These are the complete artifact state
machine modification points and their ownership bases are detailed in the
[platform integration contract](../contracts/platform-integration.md#ownership-and-modification-points).
Foreign-machine or uncertain records remain fail-closed, and shared volumes are
rejected rather than coordinated.
