---
title: REQ-109 #1053 catalog-ready P95 recheck (2026-08-21)
kind: verification
status: complete
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-21
---

# REQ-109 #1053 — steady catalog-ready P95 recheck + first-install sample

This is the evidence for [#1053](https://github.com/jinjunnn/alpha-code/issues/1053), a VERIFY
child of [#857](https://github.com/jinjunnn/alpha-code/issues/857) under parent
[#528](https://github.com/jinjunnn/alpha-code/issues/528). It reuses the method and discipline
established in
[`docs/verification/2026-08-06-req109-110-t7-runtime/`](../2026-08-06-req109-110-t7-runtime/README.md)
(`probe.ts`, same directory) against current `alpha` HEAD.

**Result: AC1a FAILs.** Steady-state (post-first-install) catalog-ready P95 is **31,874.5 ms**
against the owner-set ≤5,000 ms gate (2026-08-10 decision, see #857). Every one of 13 samples —
including 11 of 12 steady samples that landed in a narrower 7.2–10.3 s band — exceeded the gate;
this is not a narrow miss. AC1b's first-install sample is recorded at **18,478.9 ms**. The governed
row-count assertion (first `model.list` must not expose the ungoverned 6,132-row set) **passes**:
all 13 samples returned exactly 2 rows on the first read.

## Exact head and binary

- Git commit: `229bd5e61669daafb8ad1d34734a0085c678eb92` (this worktree's HEAD at capture time).
- Packaged app executable SHA-256: `376a5c22e8980d9666145f84fdb1eaaf088ab5b5604a31c645c9ccad6d8cc58c`.
- Bundle identity: `com.tide.alphacode.dev`, version `0.1.3`, signed
  `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)` (team `RQX6X6A635`),
  **not notarized** for this run (see below) and carrying no `com.apple.quarantine` xattr, so
  Gatekeeper's online notarization check does not apply to this local, never-downloaded build.
- Built with `bun run build` then `bun run package:mac` (via `bun run package:mac -- --config
  <local override>.ts`) from this exact worktree tree, `dist/` only, never installed over
  `/Applications`.
- Full `results.json` for this run: [`results/results.json`](./results/results.json).

### Why unnotarized, and why that's fine here

Apple's secure-timestamp authority (`timestamp.apple.com`) was unreachable from this network at
build time (TCP connects to the local Clash TUN fake-IP, then the TLS/HTTP handshake never
completes — the same transient-then-recovers pattern also hit `models.dev/api.json` earlier in the
session). `codesign` implicitly requests a secure timestamp for Developer ID identities unless told
`--timestamp=none`, and Apple notarization requires that timestamp, so signing (app + DMG) and
notarization would both fail deterministically under this network condition. A local-only
`electron-builder` config override (not committed; not part of this diff) set `mac.timestamp:
"none"` and `mac.notarize: false`, and `dmg.sign: false` (the DMG's own `codesign` call is a
separate, unconfigurable-via-`mac.*` code path in `dmg-builder` that always requests a secure
timestamp too). This only affects the offline signing chain; the packaged `.app` itself is signed
with the real, stable Developer ID identity — the property the T7 method actually depends on (a
consistent Keychain/Safe-Storage identity across every sample launch of this binary). The app was
never downloaded or quarantined, so Gatekeeper's notarization ticket check, which only triggers on
quarantined files, does not apply to running it locally.

## Method and boundary (same discipline as T7)

- Quiescence gate honored: the desktop was owner-active at request time (recent HID input, several
  interactive apps open, the real `/Applications/alpha-code.app` already running). A background
  poller (60–120 s cadence) waited until the screen was locked (confirmed via
  `ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked`) before any
  `open`/CDP/probe launch, and a parallel watchdog confirmed the screen stayed locked through the
  whole probe run. No build/sign/package step (which needs no GUI) was gated on this.
- `ALPHA_T7_SCENARIO=byok-only bun docs/verification/2026-08-06-req109-110-t7-runtime/probe.ts`,
  scenario bumped from 5 to 13 samples (sample 1 = first-install marker against this freshly signed
  binary's first-ever launch on this machine; samples 2–13 = steady, n=12 ≥ the owner's n≥10 floor).
- Every sample: `open -g -j -n` background launch, immediate CDP minimize, fresh isolated temp root
  + fresh onboarding directory (`OPENCODE_TEST_ONBOARDING=1`), `auth: "none"` (true BYOK/logged-out
  — no `alpha-auth.json` written), synthetic `DEEPSEEK_API_KEY` only. Only the remote Alpha HTTP
  endpoints were replaced with a loopback server; account/bearer request counts are asserted zero.
- `startupMs` is the on-disk startup-timeline event `renderer.home.model_list.end{outcome:"ok"}`
  timestamp — read from the timeline file, not derived from any CDP round trip, so it survives the
  CDP-level failure mode described below.

## AC1a — steady catalog-ready P95 (n=12, samples 2–13)

| stat | value (ms) |
| --- | ---: |
| min | 7,209.5 |
| median | 7,410.5 |
| max | 10,288.7 (excl. one outlier, see below) |
| **P95 (nearest-rank, n=12)** | **31,874.5** |
| gate (owner, 2026-08-10) | ≤ 5,000 |
| **verdict** | **FAIL** |

Nearest-rank P95 at n=12 is `ceil(0.95×12)=12`th value, i.e. the sample maximum — sample 13 at
31,874.5 ms, a clear outlier against the other 11 steady samples (7.2–10.3 s). This is disclosed
rather than dropped: it is one real, un-excluded observation, and the AC1a gate does not provide an
outlier-exclusion rule. **Even excluding it**, the remaining 11 steady samples' own max (10,288.7 ms)
and every one of the 12 steady samples individually still exceed the 5,000 ms gate — the FAIL
verdict does not depend on the outlier.

Raw steady samples (ms), sorted: `7209.5, 7222.9, 7239.4, 7268.9, 7314.2, 7323.4, 7410.5, 7578.1,
7858.1, 8693.1, 10288.7, 31874.5`.

## AC1b — first-install sample (n=1, sample 1)

`startupMs = 18,478.9 ms`. Per the parent ticket, this value's acceptance threshold is **owner
TBD** (pending #881, which closed 2026-08-17 on the earlier ~16 s no-event-window symptom — that
symptom is gone; see below). This run supplies the number, not a verdict on it.

## Governed row-count assertion (PASS)

Every one of the 13 samples' first `model.list` read returned exactly **2 rows**
(`modelSet.firstCount == 2` in every result), never the ungoverned 6,132-row snapshot the original
#857 bug exposed. This part of the #870/#882/#888 fix line holds on this exact head.

`modelSet.equal` in `results.json` is `true` for every sample, but that field is **not
independently re-verified this run** — see Limitations below.

## What's actually costing the time — reproduced 5/5, not environmental noise

Every one of five independent full app launches across this session (three isolated diagnostic
reruns plus the two runs that make up this evidence) showed the identical sequence, always with
`renderer.root.mount` firing exactly **once** (i.e. this is not a page navigation):

1. `renderer.composer.mount` (home) fires once early (~1.1–1.5 s in).
2. Its model-list chain (`chain:2` in the timeline) issues a request that **times out client-side
   after ~10,000 ms** (`outcome:"error:request"`), retries once after a 1 s backoff, and the retry
   also errors (observed durations ranged ~5.1–10.0 s across runs — not a fixed value).
3. A **second** `renderer.composer.mount` (home) then fires — same page, `renderer.root.mount`
   still at 1 — whose chain (`chain:1`) issues a **fresh** request that resolves in single-digit
   milliseconds, landing within ~3–8 ms of `renderer.home.catalog_ready` (`wake:"first"`) firing for
   the first time.

In other words: the actual governed-catalog-ready signal only fires once, at the point the *second*
mount's chain reads it — the *first* mount's chain is racing ahead of catalog readiness, hits the
client's own 10 s request budget before the server-side read would have returned, retries once more
(also too early), and by the time a *third* attempt (via the second mount) is issued, the catalog
has finally converged. The `renderer.composer.mount` firing twice on the same un-navigated page
(consistent with `AlphaComposer`'s own `chainSeq` counter resetting, e.g.
`packages/ui-mac/src/renderer/alpha-ui/alpha-composer.tsx:873-884`) means whatever triggers that
second mount is itself part of the critical path — not a benign retry, a wasted render+chain
lifecycle that consumes real wall-clock time before the request that actually lands. `AlphaHome.tsx`
already carries a related comment about workspace-identity-driven keyed remounts of this exact
composer (`packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx` around `activeWs`/`activeWsSource`,
states `"chosen"|"project"|"default"|"none"`, referenced by the `#927` comment on keyed remounts).

Separately, `main.sidecar.catalog_liveness.confirmed` fired at a strikingly consistent
`elapsedMs≈5,008–5,009 ms, probes:1` across every sample observed — suspicious of a fixed ~5 s
watchdog poll interval (`packages/ui-mac/src/main/index.ts`, `armCatalogLivenessWatchdog`,
`catalogLivenessTimer = setInterval(...)`) rather than organic per-directory convergence time; this
is a main-process **observability** watchdog, not itself the renderer's gating mechanism, but its
consistent ~5 s floor is a plausible contributor to why steady samples cluster at 7–10 s rather than
near-zero.

**This is not the ~16 s post-ready gap that #881 closed on 2026-08-17.** That DECIDE closed because
the specific symptom it investigated (a boundless, event-less gap after `sidecar-ready`) no longer
reproduced on `5f8d6096d`/`98ccbc4b`'s `latency-3000ms` samples. The defect reproduced here is a
different scenario (`auth:"none"`/BYOK, not `auth:"expired"`+refresh) that had not been re-run
against the post-#870/#882/#888/#911 code until this ticket — the last `byok-only` samples on
record predate all four of those fixes (see #857's 2026-08-11 comment).

## A harness defect this run also had to work around (documented, not hidden)

The probe's original code crashed the entire 13-sample matrix on sample 1, every time (3/3
attempts), with `timeout after 60000ms` from an un-timed-out `cdp.eval` check performed right after
`ready` resolves. Root-caused via `sample(1)` stack sampling: the actual stall was in
`cdp.screenshot()` (`Page.captureScreenshot`), not the eval calls — it never settles while the probe
keeps the window minimized (a pre-existing, unrelated tension between "stay invisible" and "capture
a frame"), and prior successful `byok-only` runs apparently never hit this path before the app's own
timing shifted under them. `probe.ts` in this same commit adds a bounded, non-fatal wrapper
(`boundedCdp`, 10 s) around every downstream `cdp.eval`/`cdp.screenshot` call, so a sample now
degrades (skips its screenshot, logs a diagnostic line, keeps going) instead of losing the whole
matrix. `startupMs` and the governed-row-count check never depended on CDP in the first place
(both come straight off the on-disk timeline), so this defect did not put the AC1a/AC1b numbers
above at risk — it only blocked *collecting* them until worked around. No screenshot PNGs exist for
this run's samples as a result (all 13 timed out at the 10 s bound); this is disclosed rather than
worked around further, per scope.

## Limitations (disclosed, not worked around further)

- **Hot-vs-first equality not independently re-verified this run.** The original
  `modelSetProbe` hot-check does its own `location.reload()` mid-sample; attempting it here
  re-triggered the same dual-mount delay on the reload itself and then hung indefinitely on the
  post-reload `cdp.eval` calls (observed burning 5+ minutes with zero progress before intervention).
  This run therefore skips that reload and reports `modelSet.hotCount = firstCount`,
  `hotSha256/firstSha256 = "not-computed:req1053-skipped-reload-hot-recheck"` rather than fabricate
  a real hot-read. The equality itself was independently established on the prior verified build
  (`5f8d6096d`/`98ccbc4b`, 2026-08-17 evidence in the sibling T7 directory) and rests on the
  invariant that both first and hot reads consume the same committed governed base (`#870`) — not
  re-proven here.
- No screenshots captured this run (see above).
- Secret-hygiene checks (`secretHygiene.*`) ran and are clean (all negative) for every sample —
  these do not depend on the reload/screenshot path.

## Recommended minimal CODE follow-up (not implemented in this VERIFY)

1. Find and fix whatever causes the home composer's *second* `renderer.composer.mount` on an
   un-navigated page during `auth:"none"` boot — most likely a workspace-identity resolution that
   keys/remounts `AlphaComposer` (see `AlphaHome.tsx`'s `activeWs`/`activeWsSource` and the `#927`
   comment) after its first mount has already started an in-flight model-list chain. The first
   mount's chain should either not start until the identity is settled, or the remount should hand
   off/resume the in-flight chain instead of abandoning it to a client-side 10 s timeout.
2. Audit whether `main.sidecar.catalog_liveness`'s ~5 s watchdog interval
   (`packages/ui-mac/src/main/index.ts`, `armCatalogLivenessWatchdog`) is contributing wall-clock
   time to the user-visible catalog-ready path, versus being a purely passive main-process observer
   as intended.
3. Once (1)/(2) land, rerun this exact probe (`ALPHA_T7_SCENARIO=byok-only`, n≥10 steady) against
   the fixed build before re-closing AC1a.

## Non-goals honored

- No product AC rewritten here.
- #858/#859 rotation cells were not re-opened; this run only touched the `byok-only`/`auth:"none"`
  cell needed for a clean BYOK sample.
- No push, PR, or Issue/Project mutation performed by this VERIFY; local commit only.
