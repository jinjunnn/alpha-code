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

The #857 candidate makes the V2 `model.list` consumer wait for the local-only
`core/catalog-ready` marker before reading `catalog.model.available()`. The marker
is registered after the built-in config-provider and variant transforms, so the
first read and stable hot read observe the same committed catalog. It does not
wait for account summary, a platform bearer, or any account network request.

The deterministic regression test supplies an observable ungoverned catalog
before the marker, proves that bypassing the marker returns that control value,
then proves both the first production read and the hot read return the governed
set in strict `wait → read` order. This is code-level candidate evidence only;
the issue remains open and the ≤2 s claim remains unmade until a quiescent
desktop window is approved and the packaged logged-out/BYOK five-sample matrix
passes.
