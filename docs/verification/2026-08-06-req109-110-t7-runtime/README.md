---
title: REQ-109/110 T7 packaged runtime matrix (2026-08-06)
kind: verification
status: complete
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-06
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

The next code candidate therefore changes only sidecar readiness ordering. It
still starts the real authenticated V2 prewarm before `Server.listen` so the two
builds overlap, but publishes ready only after both have settled. It does not
bypass `v2.model.list`, introduce a second catalog source, or wait for account or
network state. This remains unclaimed code-level evidence: the issue and PR stay
open/draft until a newly signed app passes all five samples at ≤2 s P95 with
first/hot equality.
