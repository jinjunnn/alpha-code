---
title: Alpha Code platform integration
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-13
---

# Alpha Code platform integration

This contract describes the desktop side of the Alpha Web and Alpha Platform
integration. Service wire formats remain owned by their producer repositories.

## Ownership and authority

| Surface                                                          | Owner                            | Desktop seam                                 |
| ---------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Authorization code, refresh/session rotation, endpoint discovery | `alpha-web`                      | `alpha-auth.ts`, `alpha-endpoints.ts`        |
| Model gateway and model registry                                 | `alpha-platform`                 | injected `alpha` provider                    |
| Cloud Jobs HTTP/SSE, artifacts, schedules, MCP facade            | `alpha-platform`                 | main-process clients and injected MCP server |
| Account summary and billing transactions                         | `alpha-platform` account service | main-process account client                  |

Current Alpha Platform contracts are
[`cloud-jobs-v1.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/cloud-jobs-v1.md)
and
[`account-billing.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/account-billing.md).
Endpoint precedence is defined in
[`platform-endpoint-discovery.md`](platform-endpoint-discovery.md).

## Authentication flow

1. The main process creates PKCE S256 verifier/challenge and state, then opens
   `GET <web>/auth/authorize` with client `alpha-code`, redirect
   `alpha-code://auth/callback`, and OAuth grant metadata scope
   `openid profile platform`.
2. Alpha Web authenticates the user and returns a one-time authorization code.
3. The desktop validates state and exchanges the code and verifier at
   `POST <web>/auth/token`.
4. Alpha Web returns a short-lived ES256 access JWT, rotating refresh token,
   session ID, and endpoint discovery. The JWT channel claim is `scope=user`;
   that is distinct from the OAuth grant metadata scope.
5. The desktop persists credentials in the main-process auth store, using OS
   `safeStorage` when available and restrictive file permissions for the
   documented fallback. Bearer values are never exposed to the renderer.
6. Refresh rotates the refresh token. A rejected refresh degrades to logged
   out/BYOK; transient network or server failure keeps the still-valid token
   for a later retry.

## Runtime seams

- **Model proxy:** platform mode sets the model gateway base and injects an
  `alpha` provider. BYOK providers remain direct and do not traverse Alpha
  Platform.
- **Cloud Jobs:** renderer requests cross narrow IPC handlers; the main process
  calls the Cloud Jobs HTTP/SSE and artifact APIs with the main-held bearer.
- **MCP facade:** the sidecar receives the Cloud MCP URL and a `{file:...}`
  bearer reference. The MCP facade fronts the same Cloud Jobs model; it is not
  a second execution truth.
- **Account:** the main process reads summary and transactions from the
  desktop-facing account endpoint. The renderer receives typed results, never
  the bearer.
- **Secret transport:** on each sidecar fork, login and BYOK secrets are
  mirrored into `0600` secret files. The sidecar allowlist carries non-secret
  endpoint configuration, while provider/MCP configuration carries file
  references rather than token values.

Login activates platform mode and respawns the sidecar in place when a live
window exists. Cold-start callbacks defer activation until the next normal
sidecar start. Logout clears token state and re-forks without platform
credentials.

## Managed cloud artifact persistence

Cloud artifact bytes remain in the main process and stream to a unique `.part`
file below `<project>/.alpha/runs/<run>/artifacts/`. After length and digest
verification, every production download must pass the project-owned artifact
quota finalizer; no caller has direct final-rename authority.

The admission guarantee is limited to a local filesystem with a locally
coherent directory namespace. It does not apply to NFS, SMB, remote FUSE, or
other shared/network volumes. At main-process initialization the desktop
checks the Electron `userData` volume, and on the first use of a different
artifact volume it checks that volume too. On macOS, the check requires the
mounted filesystem's `local` flag. A remote volume returns the stable
`unsupported-filesystem` error; an unknown locality result fails closed as
`disk`. Move the project and `userData` to local volumes before retrying. The
desktop does not implement NFS cache-convergence or cross-client coordination.

The desktop creates one random UUID machine identity at
`<userData>/artifact-quota-machine-id`, mode `0600`, and reuses it without
rewriting it. This installation identity, not `hostname()`, identifies records
eligible for same-machine dead-PID cleanup.

Each finalization attempt first creates and fsyncs exactly one owner-unique
reservation with an exclusive `O_EXCL` open at
`<project>/.alpha/runs/<run>/reservations/<startedAt>-<uuid>.json`. `startedAt`
is a fixed-width sortable value derived from millisecond wall-clock time; it
does not claim microsecond clock precision. The immutable record is
`{pid, machineId, declaredBytes, startedAt, uuid}`. A path is owned only by the
attempt whose UUID created it.

Admission scans reservations before final files. Run usage is committed regular
files plus the count and `declaredBytes` of every reservation below that run;
project usage is committed regular files plus `declaredBytes` from every run's
reservations. The committed scan includes legacy files that are not in a
manifest. It excludes uniquely named `.part` staging files. The finalizer checks
all of these limits before the atomic final rename:

- 100 MiB per artifact;
- 256 committed artifacts and 512 MiB per run; and
- 5 GiB across the managed project.

The committed scan already contains the current final target when one exists.
Admission therefore never subtracts an earlier target-size or target-existence
snapshot: the formula is committed usage plus all reservations, including the
caller's own full declaration. Replacing an existing target can conservatively
charge both the old final and the new declaration until rename. This can reject
a replacement that would fit after overwrite, but it removes the shared-target
check-then-act window; there is no stale value deducted after another finalizer
or `removeArtifact` changes the target.

If the combined usage is within every applicable limit, the attempt is
admitted. If it is over a run or project limit, conflicting reservations are
ordered lexicographically by `(startedAt, uuid)`. An attempt with a strictly
smaller conflicting key present deletes only its own reservation and returns
the stable, retryable `over-limit` detail
`artifact quota admission yielded to an earlier reservation`. The minimum-key
attempt subtracts all strictly greater reservations and reevaluates; it is
admitted when committed usage plus its own reservation fits. Thus greater keys
yield while the minimum key progresses, rather than all contenders repeatedly
colliding on one shared pathname. Before the minimum key performs its final
rename, it asynchronously rescans until every greater conflicting reservation
has either yielded or committed. Rescans run at most every 20 ms and are
subject to both a 5-second deadline and a 250-round ceiling. Exhausting either
bound returns the stable `retryable` error and never admits. Timer waits yield
the Electron main-process event loop; no `Atomics.wait` or other synchronous
wait is used. This convergence step closes the case where a smaller key is
published after a greater key already completed its first decision: the smaller
attempt observes the greater reservation until its final file becomes chargeable, then
reevaluates instead of double-admitting.

Immediately before rename, the admitted attempt rechecks the open staged-file
descriptor and the staged pathname against the initially captured `dev`/`ino`,
requires both to remain regular files, and requires both actual sizes to equal
`declaredBytes`. A changed inode or size returns stable `staging-changed` and is
not committed. It then reopens its reservation with `O_NOFOLLOW`, binds fd and
pathname by `dev`/`ino`, and requires the inode and exact bytes to match the
record it created. Missing or changed reservation state returns stable
`retryable`. The admitted attempt then atomically renames its own `.part` to the
final target and deletes only its still-identity-matching reservation.

Scanning reservations before final files is required on the supported local
filesystem: the owner transitions from reservation-only, through a conservative
reservation-plus-final overlap, to final-only, so a concurrent scan observes at
least one side of every commit. Quota exhaustion, malformed or unreadable
reservation state, unknown filesystem locality, or unreadable committed usage
fails closed. Errors expose a stable category and bounded quota figures, not
local paths, descriptor metadata, bearer values, or response content.

A crash before rename leaves the reservation charged even though the unique
`.part` remains excluded. A crash after rename but before reservation deletion
charges both the final file and reservation. This is intentionally fail-closed:
a crash cannot leak capacity. A later scan may unlink another reservation only
when its `machineId` equals the persistent local installation identity and PID
liveness conclusively returns `ESRCH`; `EPERM` means live, and foreign-machine,
malformed, live, or indeterminate records are never cleaned. A successful lazy
unlink remains charged for that scan and affects only a later full rescan.
Cleanup failure also keeps the reservation charged.

The owner recheck makes the two PID uncertainty directions safe: a dead owner
misclassified as live remains conservatively charged, while a live owner whose
reservation is mistakenly deleted detects the missing identity before rename
and returns `retryable`. Cross-owner deletion is therefore restricted to the
explicit same-machine plus conclusively-dead-PID recovery case; it is not a
general ownership transfer. Diagnostics and recovery boundaries are defined by
the [artifact quota reservation recovery
runbook](../runbooks/artifact-quota-reservation-recovery.md).

### Ownership and modification points

The complete write surface for this artifact state machine is:

- Reservation directory `mkdir` creates only shared structural parents and is
  idempotent; it does not claim or rewrite a peer record.
- Reservation `O_EXCL` create, write, and fsync target the caller's random
  UUID pathname. Normal failure, yield, and success unlink only that same path
  after fd/path identity and exact-content revalidation.
- Lazy cross-owner reservation unlink is the sole recovery exception. It is
  allowed only for the same persistent `machineId` plus a PID conclusively
  reported dead, and the removed declaration remains charged for the current
  scan.
- Final rename moves the caller's unique `.part` into the run-owned final
  artifact pathname. It may replace an existing final directory entry; that
  authority comes from the finalizer being the sole commit point for the
  caller-selected managed run target. The conservative quota formula does not
  pre-delete or subtract the replaced entry.
- `removeArtifact` may unlink a final file only after resolving the selected
  manifest entry inside the managed run path. Its authority is the explicit
  artifact-removal/GC operation; a failed final unlink leaves the manifest
  unchanged.
- The downloader's failure cleanup may `rm` only its invocation-unique `.part`
  pathname created with `O_EXCL`. It never removes a peer `.part` or a final
  target.

## Invariants

- Alpha Web is the authority for public identity and desktop sessions; Alpha
  Platform verifies its JWT and owns enforcement, metering, jobs, and ledger.
- The renderer never receives access, refresh, provider, MCP, or account
  bearer values.
- The model gateway and Cloud Jobs/MCP worker are separate endpoints.
- Endpoint discovery accepts HTTPS or loopback HTTP only; malformed or unsafe
  values fall through to the next precedence layer.
- Any modification to synchronized upstream paths follows the sovereignty
  ladder in ADR-029. This contract does not reinstate the superseded claim that
  all integration must be additive-only.
- Active gaps and rollout state belong in GitHub Issues and Alpha Delivery,
  not in this contract.
