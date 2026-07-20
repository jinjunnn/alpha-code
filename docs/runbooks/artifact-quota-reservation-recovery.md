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
`<project>/.alpha/runs/<run>/reservations/<startedAtMicros>-<uuid>.json`. Its
record is `{pid, hostId, declaredBytes, startedAt, uuid}`. The finalizer counts
all readable reservations before scanning committed final files, so a residual
reservation reduces available run and project capacity without making an
uncommitted `.part` visible as an artifact.

Do not remove or rewrite a reservation merely because it is old. Age is not a
liveness signal. A foreign-host record, malformed record, live PID, or
indeterminate PID probe is intentionally fail-closed.

## Automatic convergence

An active owner deletes only its own UUID-named reservation after either
yielding or failing before commit. After a successful final rename it also
deletes that same path. No contender rewrites, renames, or deletes an active
peer's reservation.

When combined usage exceeds a limit, conflicting reservations are ordered by
`(startedAt, uuid)`. A greater key observes the smaller key, deletes only its
own reservation, and returns
`artifact quota admission yielded to an earlier reservation`. The minimum key
ignores strictly greater reservations during its second quota calculation and
continues when committed usage plus its own declaration fits. It read-only
rescans before final rename until every greater conflict has either deleted its
reservation while yielding or exposed a committed final file. A smaller key
that appears after a greater key's first decision therefore cannot preempt an
unseen commit; it reevaluates the newly committed bytes. Retrying a yielded
download creates a new owner-unique reservation and rescans current disk truth.

A scan may lazily delete somebody else's residual reservation only when both of
these facts are conclusive:

1. `hostId` exactly identifies the local host; and
2. probing the recorded PID returns `ESRCH`.

`EPERM` proves the process must be treated as live. Any other probe result is
indeterminate and does not authorize cleanup. Failure to unlink a proven-dead
reservation leaves its `declaredBytes` charged; it does not authorize mutation
of a different path.

## Crash diagnosis

A crash has only conservative quota effects:

- before final rename: the reservation remains charged and the uniquely named
  `.part` remains excluded from committed usage;
- after final rename but before reservation deletion: both the final file and
  reservation are charged until dead-PID cleanup; and
- after reservation deletion: the final file alone is charged by the next disk
  scan.

For repeated `over-limit` yields or
`artifact quota admission unavailable (committed usage unavailable)`, inspect
the affected run's `reservations/` directory without changing it. Record each
filename, raw record, owner/mode, `hostId`, PID probe result, and whether the
matching final file is already present. Do not rename a `.part` directly to its
final name outside the quota finalizer.

To trigger safe cleanup, retry one finalization on the reservation owner's host.
The scan will remove records whose local PID is conclusively dead and will
leave all others charged. If the owner host is unavailable, the PID is live or
indeterminate, or the record is malformed, preserve the reservation and treat
the reduced capacity as the safe state. Do not move it to an evidence directory
or replace it with a repaired record; ownership cannot be reconstructed from a
pathname mutation.

## Residual boundary

The mechanism has no shared admission file, recovery directory, restoration
step, heartbeat, coordination process, or third-party filesystem primitive.
Every normal create/delete targets the caller's UUID-named reservation; final
commit renames the caller's unique `.part`; the sole cross-owner deletion is a
same-host reservation whose PID is conclusively dead. A shared-volume host must
therefore keep a stable, distinct `hostId`, and operators must leave
foreign-host or uncertain records fail-closed.
