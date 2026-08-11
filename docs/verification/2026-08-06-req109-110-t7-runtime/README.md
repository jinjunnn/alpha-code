---
title: REQ-109/110 T7 packaged runtime matrix (2026-08-06)
kind: verification
status: complete
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-11
---

# REQ-109/110 T7 packaged runtime matrix

This is the completion evidence for #536 at
`606e27db924267132e16767bf52ce90d42e9ff45`. The matrix completed; its result
is **not** a product PASS. Three deterministic failures were converted into
#857, #858, and #859 under the corresponding parent requirements.

## Method and boundary

- Built the real macOS app with `bun run build` and `bun run package:mac` from
  the exact head above. The isolated `dist/` bundle was signed with the local
  Developer ID so Safe Storage used the same stable Keychain identity on every
  sample. It was never copied over `/Applications`.
- Launched every sample in the background with `open -g -j -n`, immediately
  minimized the CDP target, and used a fresh `OPENCODE_TEST_ONBOARDING=1` temp
  root. Each run owned and removed only its own PID and temp root.
- Operational warning: those macOS background flags do **not** guarantee a
  visually silent lifecycle. Launch/termination may still flash a Dock icon or
  window before CDP minimizes it. Do not rerun this probe on an owner-active
  desktop; use a quiescent test window and stop if any unrelated app is visible.
- The app, renderer, sidecar, typed SDK, refresh scheduler, generation channel,
  and model request path were the packaged production code. Only the remote
  Alpha HTTP endpoints were replaced with a loopback server so latency and
  status could be deterministic without TLS interception or a real account.
- Synthetic purpose tokens were written only through the real mode-`0600`
  auth/secret-file path. `TEST_ALPHA_API_KEY` and every real credential were
  deliberately not used.
- Clash Verge and its `mihomo` service were live. The host default route was
  the Clash TUN (`utun1024`, gateway `198.18.0.1`). Controlled loopback traffic
  remained in the host's explicit loopback exception, so this proves packaged
  startup/sidecar coexistence under the real Clash TUN but does not claim a
  remote authenticated production probe.

The executable probe is [`probe.ts`](./probe.ts). Raw facts and screenshots are
under [`results/`](./results/); `results.json` contains timing/status facts only
and no token bytes.

## Matrix result

| Cell                          |         n | catalog ready min / P95 / max | Correctness result                                                                                                                                        |
| ----------------------------- | --------: | ----------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| expired + refresh 50 ms       |         5 |     2894 / **3088** / 3088 ms | **FAIL**: every run performed boot + one token-only rotation instead of a single fork (#859); P95 also exceeds 2 s (#857)                                 |
| expired + refresh 1.5 s       |         5 |     4010 / **4213** / 4213 ms | **FAIL**: no unavailable banner and ready retry ≤52 ms, but catalog P95 exceeds 2 s (#857)                                                                |
| expired + refresh 3 s         |         5 |   5164 / **10170** / 10170 ms | **FAIL**: 4/5 runs consumed the 6 s sidecar stop ceiling before token-only ready (#858)                                                                   |
| refresh timeout 10 s          |         3 |         4845 / 4978 / 4978 ms | PASS for failure semantics: transient, zero rotation/reload, mount=1, no unavailable banner                                                               |
| refresh HTTP 502              |         3 |         3342 / 4839 / 4839 ms | PASS for failure semantics: transient, zero rotation/reload, mount=1, no unavailable banner                                                               |
| refresh HTTP 400              |         1 |                       3702 ms | PASS: exact `invalid-grant` → logged-out/BYOK; no rotation/reload                                                                                         |
| refresh HTTP 401              |         1 |                   **7434 ms** | Functional PASS, latency FAIL: exact `invalid-grant`, but the first 6,132-row list took 6164 ms (#857)                                                    |
| logged-out / BYOK-only        |         1 |                   **4027 ms** | Functional PASS, latency FAIL: no platform network gate, but the first 6,132-row list took 2829 ms (#857)                                                 |
| hot renderer ×5               | 5 reloads |  66–68 ms after the cold read | PASS: stable list is 37 rows; reload/model-ready P95 120 ms; no main-triggered reload                                                                     |
| accelerated two-TTL session   |         1 |     two rotations over 64.3 s | PASS for scheduling/continuity: refresh×2, rotation×2, reload=0, mount=1, no unavailable banner; post-rotation first lists regressed to 6,132 rows (#857) |
| rotation during active stream |         1 |     rotation complete 1817 ms | PASS: honest interruption, draft preserved, reload=0, mount=1; first recovered request returned 200 with the renewed generation and no old token          |

Across the 21 latency/error samples represented by the original T7 latency
aggregate, P95 was **10148 ms** (gate: ≤2000 ms). The prior real 60-minute run
in [`../2026-07-24-req109-110-t7-matrix.md`](../2026-07-24-req109-110-t7-matrix.md)
still supplies the non-accelerated multi-TTL corroboration; this run adds an
exact-current-head accelerated two-rotation check.

## What passed

- All 27 packaged samples completed. No sample displayed the transient
  “model list unavailable” copy.
- Successful token-only rotations kept the renderer mounted once and performed
  no renderer reload. Transient/invalid refresh failures performed no rotation
  loop.
- Generation-ready woke a waiting model chain in 1–52 ms in the controlled
  renewal cells, inside the approximately 100 ms gate.
- Active-stream rotation reported the interruption, preserved the unsent draft,
  and recovered with a first 200 request whose bearer classified as `renewed`.
- Every synthetic credential check was negative for process environment,
  renderer DOM/storage, renderer-visible auth IPC state, and timeline logs. The
  real auth file mode was `0600`.

## Failures and routing

- #857 — the first packaged `v2.model.list` can expose 6,132 ungoverned rows;
  the settled hot list is 37 rows. This dominates cold-start latency and repeats
  immediately after token rotations.
- #858 — a token-only rotation can wait the full 6 s graceful-stop ceiling,
  producing the roughly 10 s plateau in the 3 s refresh cell.
- #859 — a refresh that finishes inside boot grace is flushed before the boot
  health commit, killing a boot fork that already carries the current token and
  causing an unnecessary second fork.

Each bug is P1, `In progress`, owned by `alpha-code`, assigned to Alpha Delivery
iteration `2026-W32`, and linked as a native sub-issue of #528 or #529. Thus
#536 has met its verification exit condition (matrix + evidence + bug routing),
while the parent product requirements correctly remain open until those bugs
pass their own packaged gates.

## #859 post-fix candidate

The #859 change separates an in-flight boot fork's token generation from the
generation that a healthy sidecar has committed. The in-flight value may only
suppress a duplicate rotation for the same generation; it is never published
as applied. A newer generation is not suppressed by an older in-flight boot.

Settling that in-flight value is driven **exclusively by the bounded boot
generation terminal** (`BOOT_GENERATION_TERMINAL_MS`, 30 s), which is the only
fact source on this path that is guaranteed to conclude. The first landing
settled on `health.wait` instead, and that promise can structurally never
settle: `server.ts` ends it only when the probe succeeds or the child exits
first, and `pollUntilHealthy` polls forever, so a sidecar that stays alive
without ever becoming healthy pinned the in-flight value permanently. The
rotation latch's in-flight branch schedules no retry timer and lets any
previously armed one lapse, so that generation could never rotate again — the
timer-less dead end that #600 forbids. `ready` and `injection-failed` both
count as the health line passing (the token materializes with the fork; the
`{file:}` channel does not depend on injection, matching the respawn side);
`failed` only releases the suppression and never commits a generation, so the
fail-closed rule is unchanged.

The deterministic gate composes the production units end to end —
`armBootGenerationTerminal` → settlement → `createTokenRotationLatch` /
`commitForkedTokenGeneration` — awaiting the production promises rather than
sleeping, and asserts exact counts (not bounds). It covers five repetitions of
the 50 ms ordering, boot health failure, **health that never settles**, spawn
failure before the handshake, a newer generation arriving during boot, and
injection failure with a healthy engine. Because `index.ts` cannot be imported
under `bun test` (its top level is `Effect.runFork(main)`), the four-line
settlement glue remains the one link covered only by the source anchor; the
anchor now also locks that an unbounded settlement source cannot return.

Measured on the fix branch: the narrow set (`sidecar-lifecycle`, `auth-renewal`,
`sidecar-generation`) is 58 tests passing with zero failures, the full
`bun test src` is 3884 passing / 0 failing across 272 files (base on the same
tree: 3878 / 0), and `ui-mac` typecheck is clean. Five bypass experiments were
run against production code — removing the latch's in-flight branch, making the
commit rule ignore `healthy`, removing the terminal's timeout leg, reverting the
wiring, and re-adding only the unbounded settlement source — and each turned the
corresponding assertions red.

This is not yet a packaged PASS. The signed `latency-50ms` five-sample cell must
still be rerun to establish one boot fork, zero token-only respawns, mount=1,
reload=0, no loop, and catalog P95 <=2 s. The existing probe can visibly flash
or launch a window, so it must run only in an owner-approved quiescent desktop
window; until then #859 remains open and this section makes no packaged or
latency claim.

## #858 post-fix candidate

The #858 change gives token-only rotation a bounded 500 ms graceful-stop window
before terminating the old sidecar. Structural respawns and application exit
continue to use the existing 6 s graceful budget. This preserves the explicit
active-stream interruption and renderer/draft continuity contract without
letting an old active connection block a renewed-token fork for the full stop
ceiling.

The deterministic gate drives a child that deliberately ignores the stop
message and proves that token rotation terminates it at 500 ms while the
default path does not terminate before 6 s. A production wiring gate proves
that only `token-only` selects that bounded path.

That bound alone left the mechanism inverted. The stop command crossing the
main/sidecar boundary carried no reason, so the sidecar always drained; with a
live connection the drain never completed and every token-only rotation ended
in a 500 ms wait followed by `SIGTERM`, cutting the sidecar's own shutdown
short. The current candidate carries the reason across that boundary: a
token-only stop asks the sidecar to force-close active HTTP and WebSocket
connections, so the old sidecar releases them and exits cleanly on its own and
the 500 ms is only a backstop for an engine that cannot even force-close.
Structural respawns and application exit still drain, unchanged. The
deterministic gate for this step asserts behavior rather than elapsed time —
the two shapes have the same duration band, so a duration assertion cannot
distinguish them: it drives the production `spawnLocalServer`, has the fake
child consume the emitted command through the production parser and stop
executor, and requires the engine listener to receive the force-close while no
`kill()` occurs. Three reverse assertions pin that the structural and exit
paths still drain, that both backstop budgets are unchanged, and that only an
explicit `true` requests a force-close.

The first installed signed candidate then exposed a separate continuity gap:
the main process and renderer stayed mounted, but every scheduled token-only
rotation tore down the renderer's project SDK and inserted a transient
`Syncing…` composer row. The process evidence showed no crash, no renderer
reload, and an expected sidecar exit with code 0; the visible layout churn made
that healthy renewal look like a desktop restart. The follow-up keeps the
same-URL/same-password SDK owner stable, closes a separate execution gate while
the sidecar is unavailable, and rebuilds only if the token-only generation
actually fails. Active responses still take the explicit interruption path
and preserve their draft.

The signed 3 s renewal cell already established approximately 1.15 s from
rotation request to generation ready in all five samples, and the active-stream
cell preserved the draft, reported the interruption, kept mount=1/reload=0,
and completed its first post-rotation request with only the renewed token. The
new idle-continuity follow-up still requires a rebuilt signed candidate and a
quiescent-desktop rerun before #858 can close.

## #857 candidate verification (not yet packaged-complete)

The first signed #857 candidate removed the 6,132-row bundled models.dev
snapshot and proved that the first and hot provider/model identities were the
same governed set, with zero account or bearer requests. It did **not** meet the
latency gate: the empty base still waited for the late ConfigProvider commit, so
five logged-out/BYOK samples became ready in 3,965–13,968 ms.

The current code candidate instead derives a minimal models.dev base
mechanically from Alpha's existing provider projection. The base carries only
the exact provider/model identities, names, endpoint, upstream schema-required
conservative values, and a V2-only unavailable readiness marker with no models;
it never reads or writes a key and does not define a second allow/deny policy.
ModelsDevPlugin can therefore commit the complete governed identity set before
the late ConfigProvider metadata/variant overlay. If an enabled provider exists
only in a user file and cannot be completely represented by the in-memory
projection, the base is `{}` without the marker and the renderer conservatively
waits for the existing late ConfigProvider commit instead of exposing a partial
set. The typed renderer model contract still polls `provider.get(marker)` in the
same directory before issuing its first `model.list`; neither path reads account
summary, a platform bearer, or any account network request.

The deterministic regression test supplies an observable ungoverned catalog
before the marker, proves that bypassing the marker returns that control value,
then proves both the first production read and the hot read return the governed
set in strict `provider.get(marker) → model.list` order. The injection test
also schema-decodes every generated base entry, compares its identity set with
the existing V2 projection, rejects key material, and pins the incomplete
user-file-provider fallback. This remains code-level candidate evidence: the
issue stays open and the ≤2 s claim remains unmade until the rebuilt signed
app passes the logged-out/BYOK five-sample matrix.

A second signed candidate at joint RC
`9528cc24065fa7efb8de6f6e5ea1d816d9d3edb7` (app executable SHA-256
`0d86adecb343c3d215cb22dd09ed60042e7f08079f010ccdfcbe60a8550f150b`)
proved the identity fix but failed the timing gate. Its five BYOK-only samples
were 16,123.905 / 4,113.954 / 2,989.986 / 3,491.911 / 2,985.562 ms, so P95
was **16,123.905 ms**. Every sample still had the exact same first/hot two-row
governed set, zero account/bearer requests, zero rotation/reload, and negative
secret-hygiene checks. The first V2 marker request was paying the lazy
per-location service-graph construction; moving the governed base before the
internal plugin batch fixed correctness but did not eliminate that cost.

A third signed candidate at joint RC
`ff0cf54a4fb3152f72c0e2d6c892e20a541eee22` (app executable SHA-256
`5b6aa738d627d3ed8278dd2a8be67ef7fa1d363d2770e1b03e7c3e287cc2229b`)
started an in-process marker request in parallel with socket listen, but the
five BYOK-only samples were 15,295.444 / 4,625.020 / 3,581.587 / 4,022.536 /
3,390.514 ms; P95 was **15,295.444 ms**. First/hot identity equality, zero
account/bearer requests, zero rotation/reload, and secret hygiene all remained
correct. Source-level diagnosis found two exact causes: the request lacked the
sidecar's Basic authorization and stopped before `LocationMiddleware`, while
upstream `Default` and `listen` independently called `createRoutes` and used
different memo maps, so they could not share a `LocationServiceMap` anyway.

The fourth signed candidate at joint RC
`afdcf28fc717fa19ab96260a5b2a85292918fe3a` (app executable SHA-256
`b5ddff952ace51de6c2af386f06ee4e815dfd0b7612a88eb3a8d09b5d095e885`)
authenticated that in-process request and applied the strict Alpha-owned
generated-output patch: only the fixed Electron `cors=["oc://renderer"]`
listener reused `Default`'s singleton routes and global memo map; all other
listeners retained `createRoutes(opts)`. Correctness stayed green, but its five
BYOK-only startup values were 18,667.736 / 3,372.860 / 5,249.261 / 3,485.976 /
3,861.934 ms, so the directly recomputed nearest-rank P95 was **18,667.736 ms**
and the timing gate failed. Every sample still returned the exact same first/hot
two-row governed set with zero account or bearer requests. The two recorded
renderer mounts are expected: this probe deliberately calls `location.reload()`
after the first successful read to compare the hot set. The summary's
`latency.samples=0` is also expected under the current probe whitelist, which
excludes `byok-only`; these five raw values, rather than that aggregate field,
are the #857 P95 evidence.

The failed candidate published sidecar ready as soon as socket listen completed
while the local graph prewarm was still in flight. An isolated no-GUI diagnostic
against the exact generated engine bundle reproduced the same shared
`Default`/listener route and memo map with the bundled Alpha extension: listener
build completed in 150.89 ms, the concurrent authenticated prewarm in 187.36 ms,
and the following socket model request in 9.57 ms. This supports a narrower
scheduling diagnosis: starting the renderer before prewarm settlement causes the
packaged contention; the graph does not intrinsically require the observed 2–5 s
when it runs before renderer startup.

The fifth signed candidate at joint RC
`fb0a83e9eb84e2d950966f194468ba24a5aed395` (app executable SHA-256
`2d387e88856d1db11e670f4d4ee18e2275f757bfd2064302f53152a1e294db95`)
changed only sidecar readiness ordering: it started the real authenticated V2
prewarm before `Server.listen` but published ready only after both settled. Its
five BYOK-only startup values were 16,290.028 / 3,516.540 / 3,410.652 /
3,499.337 / 3,454.527 ms, so nearest-rank P95 was **16,290.028 ms** and the gate
still failed. First/hot identity equality, two governed rows, zero account or
bearer requests, zero main reloads, and negative secret checks remained green.

The new ordering made the remaining cold seam exact. Sidecar ready occurred at
1,073–1,587 ms, but the first renderer model-contract call then spent
1,909–2,105 ms on its real marker-plus-model read in four ordinary samples; the
same socket `/api/model` handler immediately returned in 6–16 ms afterward.
Thus waiting for the marker prewarm alone does not mechanically prove that the
renderer's actual model handler has settled before startup contention begins.

The next code candidate retains the same sidecar-owned local path and extends
the prewarm in one direction only: after the governed marker succeeds, it reads
the same directory's real `/api/model` handler and consumes that response before
ready. It does not cache or expose the response, bypass the renderer's own
`v2.model.list`, introduce a second catalog source, or wait for account or
network state. This remains unclaimed code-level evidence: the issue and PR stay
open/draft until a newly signed app passes all five samples at ≤2 s P95 with
first/hot equality.

The prewarm is deliberately scoped to the default `~/Alpha` home directory
carried in the sidecar start command. Other directory/workspace refs still take
their real cold location-graph path; this evidence does not claim a process-wide
catalog cache. The ready gate is bounded at 2,000 ms, marker and model response
bodies are both consumed, and renderer evidence distinguishes
`error:catalog-not-ready` from a general `error:request`.

The sixth signed candidate at joint RC
`c47f138953ee340b460b372749e7d6f59374ea91` (app executable SHA-256
`cf3370162ed955734d21e26c48c2a3a4fc5970bf82fed9742c33b55b48aef7f2`)
extended the prewarm through the real model handler but still failed the timing
gate. Its five BYOK-only startup values were 24,985.102 / 6,319.862 /
3,518.196 / 4,452.116 / 4,658.581 ms, so nearest-rank P95 was
**24,985.102 ms**. Every sample retained first/hot equality at the exact same
two-row SHA, made zero account or bearer requests, performed zero rotation or
main-triggered reload, and passed all secret-hygiene checks.

The named readiness outcome made the failure mode observable. Sample 1 emitted
two consecutive `error:catalog-not-ready` ends, each at the 10 s request-abort
timeout. That proves the intended 1.5 s readiness deadline did not bound wall
clock before a separate chain returned the two-row set in 7.5 ms. The other four
samples returned the first two-row set, but the initial model-list chain still
took 2,012.7–4,828.2 ms after sidecar ready was published at 1,071–1,143 ms.
Thus the 2 s bounded prewarm correctly avoids holding sidecar ready indefinitely,
but it does not make the renderer's first production contract meet the <=2 s
gate. The issue and PR remain open/draft; #858 and #859 were not run because #857
did not pass. The preserved raw facts are
[`results/byok-only-c47f1389.json`](./results/byok-only-c47f1389.json).

The RC-only probe variant that produced those facts was not included in the
evidence commit, and its artifact whitelist omitted
`renderer.home.model_list.retry_tick`. Therefore the preserved JSON cannot be
used to claim that no retry occurred; sample 1's 1,004 ms gap between attempts
is consistent with the first 1 s recovery backoff. The executable probe in this
directory now contains the exact BYOK-only row/hash and secret-hygiene capture
and retains `retry_tick` events for the next signed run.

The seventh signed candidate at joint RC
`8f023b7c0b187f9927a2b58d3b325de3c18ee64a` (app executable SHA-256
`f991100a7ebda20c71cebc5549a8b4a54167869fdfdc28c700c59ed547fd5800`)
made the 1.5 s readiness budget a real wall-clock bound and preserved caller
abort classification, but it still failed the packaged timing gate. The
notarized app passed strict `codesign`, Gatekeeper, and stapler validation. Its
five BYOK-only startup values were 20,051.873 / 4,333.817 / 4,499.791 /
4,436.110 / 4,989.793 ms, so nearest-rank P95 was **20,051.873 ms**.

Every sample retained first/hot equality at the same exact two-row SHA, made
zero account or bearer requests, performed zero rotation or main-triggered
reload, displayed no unavailable state, and passed all secret-hygiene checks.
The corrected timeline now distinguishes the failure precisely. Samples 2–5
each ended the initial readiness attempt as `error:catalog-not-ready` in
1,502.3–1,502.7 ms, recorded one `retry_tick`, then returned the governed set
on the next attempt in 359.0–1,012.7 ms. Sample 1 recorded four separately
bounded readiness failures in 1,501.4–1,502.3 ms and three retry ticks before a
separate production chain returned the same set in 5.1 ms. Thus the earlier
10 s mislabeled hang is closed, but the bounded barrier plus recovery path does
not make the first packaged production contract meet the <=2 s gate.

The summary's `latency.samples=0` remains a probe aggregate limitation for the
BYOK-only scenario; the five raw `startupMs` values above are the #857 timing
evidence. The issue and PR remain open/draft. Per the hard stop, #858 and #859
were not run, and no production or real-credential probe was attempted. The
preserved raw facts and screenshots are
[`results/byok-only-f991100a.json`](./results/byok-only-f991100a.json) and
`results/byok-only-f991100a-{1..5}.png`.
