---
title: Alpha Code platform integration
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
review_after: 2026-10-13
---

# Alpha Code platform integration

This contract describes the desktop side of the Alpha Web and Alpha Platform
integration. Service wire formats remain owned by their producer repositories.

## Ownership and authority

| Surface                                                          | Owner                            | Desktop seam                                 |
| ---------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Authorization code, refresh/session rotation, endpoint discovery | `alpha-web`                      | `alpha-auth.ts`, `alpha-endpoints.ts`        |
| Manifest-bound `upload_consent` issuance                         | `alpha-web`                      | main-process upload issuer client            |
| Model gateway and model registry                                 | `alpha-platform`                 | injected `alpha` provider                    |
| Cloud Jobs HTTP/SSE, artifacts, schedules, MCP facade            | `alpha-platform`                 | main-process clients and injected MCP server |
| Account summary and billing transactions                         | `alpha-platform` account service | main-process account client                  |

Current Alpha Platform contracts are
[`cloud-jobs-v1.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/cloud-jobs-v1.md)
and
[`account-billing.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/account-billing.md).
Endpoint precedence is defined in
[`platform-endpoint-discovery.md`](platform-endpoint-discovery.md).

## Pinned Alpha contract consumer

The desktop consumes Alpha Platform v1 through
`packages/alpha-contracts-consumer`. Its
`alpha-platform-contract.lock.json` pins repository
`jinjunnn/alpha-platform` at immutable commit
`62c7aa6de5589cfcf2af00ecab69f1d3d176512b` and records the SHA-256 of every
vendored schema, limit document, producer fixture, consumer fixture, and
negative fixture. This pin is independent of `bun.lock`.

### Ledger V1 hard cut

That pin carries the `LedgerPageV1` hard cut (`alpha-platform#101`). A ledger
entry is now an append-only *fact* — `seq` (descending page cursor), `op_id`,
`kind`, `domain`, a signed `amount`, and `created_at` in epoch milliseconds —
replacing the former mutable `{id, type, title, amount_fen, status}` row at an
unchanged `schema_version`. The change is deliberately breaking in place: no
dual-shape decoder exists, and a pre-cut page now fails closed.

Two consequences bind on readers of this surface. `amount` carries its sign, so
a credit and a debit are distinguished by the value and never by a separate
status. Its unit is chosen by `domain` — `wallet` counts fen, `allowance`
counts credits — so amounts from the two domains must never be summed.

The desktop's side of the platform deploy gate
(`contracts/v1/consumer-cutover-required.json`) is the consumer pin
[`fixtures/consumers/alpha-code-640/ledger-page.json`](../../packages/alpha-contracts-consumer/fixtures/consumers/alpha-code-640/ledger-page.json),
which declares the released `ui-mac` version and is decoded by the shipped
strict decoder in this repository's own gate. It lives outside `vendor/`
because `vendor/` is hash-locked to upstream bytes and this fixture is authored
here.

The package is a consumer only: its schemas and fixtures are byte copies of the
pinned producer release, while its code supplies strict decoders and safe
`contract-incompatible` errors. CI verifies the vendored bytes against the lock
and runs both producer and consumer fixtures. Missing, unknown, future, or
otherwise invalid versions fail closed; no compatibility shim is selected.

The same package holds a second, independent pin for the surfaces `alpha-web`
owns. `alpha-web-contract.lock.json` pins repository `jinjunnn/alpha-web` at
immutable commit `b597f0d548db9ffafc6d6301e548dbd323c810ad` and records the
SHA-256 of the two consumer fixtures that repository publishes for this desktop —
endpoint discovery (`alpha.web-identity.endpoint-discovery.v1`) and the account
summary display projection (`alpha.web-account.summary.v1`) — plus the account
summary schema itself. All three are vendored byte-identically under
`vendor/alpha-web/`.

Those fixtures are exercised through the shipped decoders, not through a second
statement of the shape:
[`alpha-web-contract-fixtures.test.ts`](../../packages/ui-mac/src/main/alpha-web-contract-fixtures.test.ts)
feeds each fixture `value` into `decodeEndpointDiscovery()` and into the decode
function `fetchAccountSummary()` passes to `createAuthedGet`. An upstream release
whose shape those decoders reject therefore turns the merge gate red as soon as
the pin is bumped. The account summary is decoded, not cast: a response the
published contract does not describe raises `contract-incompatible` and the
contract-health alert instead of reaching the renderer as a malformed summary.
A payload the published schema allows is never rejected, and a payload it
forbids never passes. Where that schema is looser than this repository's own
types, the schema wins and the decoder discards what it cannot represent rather
than refusing the response: an inactive plan is accepted with any non-empty `id`,
an optional `name`, and any other plan property the schema permits, of which only
`id` and `name` survive into `AccountPlan`. Optional is not unconstrained,
however — the schema still constrains those values, so a discarded property is
validated before it is dropped. Skipping that check would route a producer's
contract violation around `contract-incompatible` and around the contract-health
alert. The one deliberate narrowing is the active branch, whose variant cannot be
built without `name`, both credit windows, `renewsAt` and `daysLeft`.

Each object is screened once against the property set its schema declares, and
those key sets are asserted equal to the vendored schema's `properties` by the
same test file. An upstream release that adds an optional property therefore
turns the merge gate red when the pin is bumped, instead of silently making the
decoder over-strict — which is how it twice came to reject conforming
inactive-plan payloads.

## Authentication flow

1. The main process creates PKCE S256 verifier/challenge and state, then opens
   `GET <web>/auth/authorize` with client `alpha-code`, redirect
   `alpha-code://auth/callback`, and OAuth grant metadata scope
   `openid profile platform`.
2. Alpha Web authenticates the user and returns a one-time authorization code.
3. The desktop validates state and exchanges the code and verifier at
   `POST <web>/auth/token`.
4. Alpha Web returns a short-lived access JWT, rotating refresh token, session
   ID, and optionally a versioned endpoint discovery payload. Before
   persistence, the desktop decodes the JWT payload as the platform-access
   branch of `TokenClaimsV1` and requires v1 `iss`, `aud`, `token_use`,
   `purpose`, and `scope` claims.
5. The desktop does not request or mint purpose-specific tokens in this
   requirement. It only consumes a received token, and each route asks for the
   matching purpose. A purpose/scope mismatch fails the route and publishes a
   persistent visible contract failure; the token is never repurposed.
6. The desktop persists validated credentials in the main-process auth store, using OS
   `safeStorage` when available and restrictive file permissions for the
   documented fallback. Bearer values are never exposed to the renderer.
7. Refresh rotates the refresh token only after the new access claims validate.
   A contract-incompatible refresh remains a visible failure and cannot replace
   the last validated token. A rejected refresh degrades to logged out/BYOK;
   transient network or server failure keeps the still-valid token for a later
   retry. The desktop models refresh as `refreshed`, `still-valid`,
   `transient-failure`, or `invalid-grant`. Scheduling is driven by the stored
   `expiresAt`: the advance window is one third of the issued lifetime, capped
   at five minutes, so a 15-minute token is due after about ten minutes.
   Successful refresh, auth-state change, and system resume re-arm the
   scheduler; a 30-second minimum wake interval prevents clock-skew loops.
8. An expired token at cold start begins refresh immediately. The first
   sidecar fork waits at most 1.2 seconds for that same request, then starts
   local/BYOK availability while a slow refresh continues. A successful late
   result may rotate the running sidecar once for its token generation.
   Transient or invalid-grant results never enter a token-rotation loop.

## Runtime seams

- **Model proxy:** platform mode sets the model gateway base and injects an
  `alpha` provider. BYOK providers remain direct and do not traverse Alpha
  Platform.
- **Cloud Jobs:** renderer requests cross narrow IPC handlers; the main process
  calls the Cloud Jobs HTTP/SSE and artifact APIs with the main-held bearer.
  Submit, status, and cancel all speak the versioned platform#255 contract
  (`CloudJobRequestV1` / `CloudJobStatusV1` / `CloudJobCancelResultV1`):
  - *Idempotent submit:* `idempotency_key` is required by the wire contract and
    is minted exactly once per user intent inside main's envelope guard
    (`cloud-envelope-guard.ts`); a renderer-supplied key is rejected loud. The
    dispatch POST performs a bounded client retry (hard ceiling of 3 attempts,
    transport failures and 502/503/504 only) that re-serializes the *same*
    guarded envelope, so every retry of one intent carries the same key and the
    platform can collapse duplicates onto the original job
    (`idempotent_replay`). 401/403/4xx/429 answers are never retried.
  - *Cancel is server-decidable:* the cancel response is decoded strictly as
    `CloudJobCancelResultV1` (`accepted` + current status). The public status
    enum's seventh value `cancelling` means "cancel accepted, stop protocol not
    yet closed" — the desktop shows it as *cancelling*, never as cancelled, and
    only an SSE terminal event (`job.cancelled`/`completed`/`failed`) moves the
    UI to a terminal state. The pre-#255 unversioned cancel body fails closed
    as contract-incompatible; there is no compatibility branch.
  - *Status:* `cancelling` decodes as itself, and a dead dispatch arrives as
    `failed` plus `reason: "dispatch_dead"`, not as an eighth status value.
- **MCP facade:** the sidecar receives the Cloud MCP URL and a standard MCP
  OAuth client declaration (`clientId` is a Client ID Metadata Document URL;
  `redirectUri` is the loopback callback the engine's own callback server
  binds). The sidecar does **not** receive a bearer for this server: the
  engine's OAuth credential store holds and refreshes the credential, keyed by
  server URL. A missing or rejected credential surfaces as `needs_auth`, which
  the desktop presents with a re-authorize action — rotating `ALPHA_CLOUD_TOKEN`
  does not affect it. The MCP facade fronts the same Cloud Jobs model; it is
  not a second execution truth.
- **Account:** transactions are decoded as `LedgerPageV1`/`LedgerEntryV1`
  before renderer projection. Account summary remains outside this pinned
  contract until its producer publishes a schema and does not block the ledger
  consumer. A summary 401 performs one single-flight refresh and one retry;
  successful refresh uses the same generation-latched sidecar token-rotation
  entry as scheduled and cold-start refresh.
- **Secret transport:** on each sidecar fork, login and BYOK secrets are
  mirrored into `0600` secret files. The sidecar allowlist carries non-secret
  endpoint configuration, while provider configuration carries file references
  rather than token values. `ALPHA_CLOUD_TOKEN` is still written and is still
  the platform-pays predicate (its presence, together with the Cloud MCP URL,
  gates cloud registration and web-search sovereignty), but it is no longer a
  credential source for the Cloud MCP server — that server's configuration
  carries neither a token value nor a file reference.
- **Sidecar continuity:** main publishes token-free `recovering` and `ready`
  states with a monotonically increasing sidecar generation. Pure token
  rotation re-forks on the same URL and password, rebuilds renderer SDK/SSE
  connections, and does not reload the page. Login, logout, auth-mode, proxy,
  and provider-key changes remain structural respawns and retain the existing
  renderer reload. Coalesced respawns escalate to structural when any queued
  request is structural. If a generation boundary intersects an active
  response, the renderer clears the local busy state, preserves an unsent
  draft, and reports the interruption; this is not durable provider
  continuation.
- **Catalog and account readiness:** model directory loading starts as soon as
  the directory SDK is available and runs in parallel with account summary.
  Account state gates platform entitlement and platform send permission only;
  it does not gate local/BYOK catalog rows. During transient recovery the
  renderer keeps previously rendered rows with a syncing state. An expired,
  unverified platform token is recovering and is never presented as usable.

Login activates platform mode through a structural sidecar respawn when the
first fork does not already contain that auth generation. Logout clears token
state and structurally re-forks without platform credentials.

## Explicit cloud file upload and conditional consent

Only the desktop's explicit Cloud Jobs file picker enters the upload-consent
protocol. Model prompts and attachments are not uploads under this contract.
Existing `input.diff` and `code-review` dispatch remain the v1
`grandfathered` egress classes: they are neither disabled nor retrofitted with
an upload manifest. Cloud schedules, bounded-agent envelopes, and the MCP
sidecar have no upload-consent field or token channel.

The main process is the sole upload authority. The renderer can request a
`code-review` file selection and can later confirm or cancel a main-issued
opaque request ID. It cannot provide paths, file bytes, a manifest, a consent
decision, or a token. Main asks the user for one project root and an explicit
set of files, resolves the canonical paths, rejects missing, outside-root,
symlinked, duplicate, non-regular, unreadable, and non-UTF-8 inputs, then reads
and freezes the exact content in memory. An empty or unverifiable selection is
cancelled; it never becomes a whole-project selection.

For that immutable snapshot, main creates the vendored `UploadManifestV1` with
the access-token `sub` as `tenant_id`, normalized relative paths, byte sizes,
per-file SHA-256 summaries, total count and bytes, creation time,
`retention_class`, the required `explicit.file-upload` egress declaration, and
`consent_required`. It validates the schema plus count/total/path-uniqueness
invariants and hashes the exact JSON string later sent to the Cloud Jobs
gateway. Admission fails before issuance above 256 files, 100 MiB total, or
the existing 256 KiB control-envelope limit. The latter is normally the
tightest v1 bound because explicit UTF-8 contents travel inside that envelope.

Client classification is intentionally broader than the platform fallback.
It detects email, bare mainland-China mobile numbers, E.164 numbers (including
sentence-final punctuation), Chinese identity-number shapes, private-key and
credential patterns, and credential-sensitive paths. Pure code and unrelated
numeric content do not become sensitive merely for containing numbers.
Classifier exceptions or malformed results fail closed as sensitive. When no
protected information is found, main dispatches immediately and the renderer
shows one non-blocking transparency line. When protected information is found,
the renderer uses the approved house Dialog/Button surface to show the bounded
file preview, findings, purpose, and retention; cancel mints nothing and sends
nothing.

After confirmation, main reacquires a `cloud.dispatch` access token and
requires the same valid `sub`, then calls the Alpha Web-owned
`POST <web>/auth/upload-consent` issuance seam. The request carries the exact
manifest JSON and its SHA-256. Alpha Web must return the vendored
`upload_consent` JWT branch (`iss=alpha-web`, `aud=alpha-platform-upload`,
`token_use=upload_consent`, `purpose=artifact.upload`). Main checks its subject,
expiry, manifest ID, manifest SHA-256, and egress declaration before sending
the frozen request to Cloud Jobs with `X-Alpha-Upload-Consent`. The desktop
does not call or describe an Alpha Platform issuance API. Deployment of the
real Alpha Web issuer remains an Alpha Web integration prerequisite; desktop
tests use a mocked issuer response.

Pending consent is one-shot process memory, scoped to the requesting renderer,
and consumed before issuance begins. It is never stored in project prefs.
Tokens, manifests, and file bytes never cross preload; handler return values
are checked again at runtime. Upload errors log only a stable code and omit
bearers, issuer responses, and absolute paths. Any attempt to inject upload
control fields through an ordinary renderer or agent envelope fails with
`upload-main-gate-required`.

## Managed cloud artifact persistence

Cloud artifact bytes remain in the main process and stream to a unique `.part`
file below `<project>/.alpha/runs/<run>/artifacts/`. After length and digest
verification, every production download must pass the project-owned artifact
quota finalizer; no caller has direct final-rename authority.

The descriptor entering this existing alpha-work#1/#2 pipeline is decoded as
the pinned `ArtifactDescriptorV1`. Artifact lists, HTTP results, and MCP results
carry descriptors only. Legacy metadata or inline content is rejected, and a
content-endpoint 404 does not trigger an inline compatibility request.

The admission guarantee has a deployment precondition: the artifact root must
be on a local filesystem with a locally coherent directory namespace. NFS,
SMB, remote FUSE, and other cross-machine shared/network volumes do not satisfy
this precondition. The desktop does not attempt runtime volume-type detection.
User space has no reliable, non-bypassable predicate across filesystem type
numbers, mount-table formats, and parent-path replacement between a check and
the later open/rename. Operators must confirm the placement as described in the
[artifact quota reservation recovery
runbook](../runbooks/artifact-quota-reservation-recovery.md#deployment-precondition).

If the artifact root is placed on a cross-machine shared volume, delayed or
incoherent namespace observations can cause contenders to miss peer
reservations or committed files and admit more run count, run bytes, or project
bytes than the configured quota. This residual is confined to quota
over-admission; it does not expand the finalizer's path authority, corrupt
artifact bytes, or grant privileges. The desktop does not implement remote
cache convergence or cross-client coordination.

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
subject to both a 5-second deadline and a 250-round ceiling. Reservation and
committed traversal uses asynchronous directory reads and stats, with an
explicit event-loop yield every 32 visited entries. The former 10,000-entry
limit is a cooperative scan slice: reaching it yields while retaining the
directory-entry position, recursive call stack, and accumulated usage, then
resumes the same complete reservation-before-committed scan.

The first complete admission scan has its own 30-second wall-clock budget. This
is deliberately wider than the 5-second contender-convergence budget because
it covers one full project traversal and allows stable projects well beyond one
10,000-entry cooperative slice to complete, while still bounding a very large,
slow, or continuously growing tree. Reaching 30 seconds returns stable
`retryable` detail `quota scan timed out`; no partial scan is admitted. A
convergence rescan is clipped directly to its remaining 5-second global budget
and likewise never admits a partial scan. The finalizer also races its
asynchronous wait-path owner-reservation recheck against that convergence
deadline. Exhausting a deadline or the round ceiling never admits. This
convergence step closes the case where a smaller key is published after a
greater key already completed its first decision: the smaller attempt observes
the greater reservation until its final file becomes chargeable, then
reevaluates instead of double-admitting.

Immediately before rename, the admitted attempt asynchronously rechecks the
open staged-file descriptor and the staged pathname against the initially
captured `dev`/`ino`, requires both to remain regular files, and requires both
actual sizes to equal `declaredBytes`. A changed inode or size returns stable
`staging-changed` and is not committed. It then asynchronously reopens its
reservation with `O_NOFOLLOW`, binds fd and pathname by `dev`/`ino`, and requires
the inode and exact bytes to match the record it created. Missing or changed
reservation state returns stable `retryable`. The admitted attempt then
atomically renames its own `.part` to the final target and deletes only its
still-identity-matching reservation.

After a retryable convergence or scan timeout, self-reservation reread/delete
gets an independent 100 ms application wait budget and staged-handle close gets
a separate 100 ms application wait budget. If either budget expires, the state
machine stops awaiting that cleanup and returns the already selected error; it
does not proceed to final rename. A cleanup syscall already issued may settle
later, but no later unlink is started after an over-budget reservation reread.
The safe worst case is an unremoved self-reservation that remains charged and
reduces available capacity. Normal event-loop scheduling can add timer jitter;
these budgets do not claim that the operating system cancels in-flight I/O.

Scanning reservations before final files is required on the supported local
filesystem: the owner transitions from reservation-only, through a conservative
reservation-plus-final overlap, to final-only, so a concurrent scan observes at
least one side of every commit. Quota exhaustion, malformed or unreadable
reservation state, scan timeout, or unreadable committed usage fails closed.
Errors expose a stable category and bounded quota figures, not local paths,
descriptor metadata, bearer values, or response content.

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
- Versioned endpoint discovery accepts HTTPS or loopback HTTP only; an
  unversioned, partial, future, malformed, or unsafe discovery payload fails
  atomically without falling through to another precedence layer.
- Contract failures are recorded without tokens or payloads, returned to the
  caller, and exposed through a persistent renderer `role=alert` banner.
- Any modification to synchronized upstream paths follows the sovereignty
  ladder in ADR-029. This contract does not reinstate the superseded claim that
  all integration must be additive-only.
- Active gaps and rollout state belong in GitHub Issues and Alpha Delivery,
  not in this contract.
