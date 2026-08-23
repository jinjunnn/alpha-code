---
title: REQ-109 #1080 post-#1056 catalog-ready P95 recheck (2026-08-23)
kind: verification
status: complete
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-23
---

# REQ-109 #1080 — steady catalog-ready P95 recheck after #1056

Evidence for [#1080](https://github.com/jinjunnn/alpha-code/issues/1080), the post-fix recheck of
[#1053](https://github.com/jinjunnn/alpha-code/issues/1053)'s FAIL. Same method, same probe, same
scenario as
[`docs/verification/2026-08-21-req109-1053-catalog-p95/`](../2026-08-21-req109-1053-catalog-p95/README.md),
run against `alpha` HEAD with the #1056 fix
(`aa48ff2d1 fix(ui-mac): #1056 冷启动只挂一次 home composer`) in the tree.

**Result: AC1a still FAILs.** Pooled steady-state catalog-ready P95 is **31,966.5 ms** against the
owner-set ≤5,000 ms gate (2026-08-10 decision, see #857). AC1b's first-install sample is
**18,179.5 ms**. The governed row-count assertion **passes**: all 26 samples' first `model.list`
read returned exactly 2 rows.

**#1056 did move the needle, and this is not a "nothing changed" result.** 20 of 26 samples now
converge in a tight 3.7–4.2 s band with a single model-list chain that resolves in 5–19 ms — a
regime #1053 never observed. But a **10-second request failure path survives** and fires on 6 of
26 samples, producing a hard tail at ~31.95 s and one sample at 55.7 s. The gate is a P95, so the
tail decides it.

The most important operational finding: **one 13-sample run is not enough to evaluate this gate.**
Run B (13 samples) hit the tail zero times and on its own reads **PASS at 4,203.3 ms**. Run C
(13 samples, same binary, same conditions, 30 seconds later) hit it 6 times and reads **FAIL at
55,698.0 ms**. A single-run recheck would have closed AC1a on a coin flip.

## Exact head and binary

- Git commit: `fe2e042f19a4a448165b023f23f664ab2b18760e` (branch `verify-1080-post1056-p95`,
  base `origin/alpha`).
- Packaged app executable SHA-256: `1183a64d23817f365125fc4a3b011cc02da8f504f6d75f45469b418f4926cb79`.
- Bundle identity `com.tide.alphacode.dev`, version `0.1.3`, signed
  `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)` (team `RQX6X6A635`),
  `codesign --verify --deep --strict` passes, **not notarized** (see below), no
  `com.apple.quarantine` xattr.
- Built with `bun run build` then `ALPHA_SIGN=1 bun run package:mac -- --config <local override>`
  from this exact worktree; `dist/` only, **never installed over `/Applications`**.
- Machine/boundary facts: [`environment.json`](./environment.json).

### Why unnotarized

Apple's secure-timestamp authority was unreachable from this network at build time —
`codesign --force --sign <Developer ID> --timestamp` returned
`The timestamp service is not available.` on **3 of 3** consecutive attempts against a throwaway
binary. `codesign` implicitly requests a secure timestamp for Developer ID identities and Apple
notarization requires that timestamp, so signing and notarization would both fail deterministically.
An uncommitted local `electron-builder` override set `mac.timestamp: "none"`, `mac.notarize: false`,
`dmg.sign: false` — the same pattern documented in #1053 — plus `mac.target: ["dir"]`.

`target: ["dir"]` is this run's one deviation from #1053, and it is a simplification: the probe
consumes `dist/mac-arm64/alpha-code.app` directly, while `dmg-builder` issues its own `codesign`
call that always requests a secure timestamp and is not configurable through `mac.*`. Emitting the
`.app` only removes that known-broken code path instead of working around it. The property the T7
method depends on — a stable Developer ID signature, so Keychain/Safe-Storage identity is constant
across every sample launch of this binary — is unaffected.

## Method

- `ALPHA_T7_SCENARIO=byok-only bun docs/verification/2026-08-06-req109-110-t7-runtime/probe.ts`,
  the `byok-only` scenario at its #1053 setting of 13 samples per run.
- Every sample: `open -g -j -n` background launch, fresh isolated temp root, fresh onboarding
  directory (`OPENCODE_TEST_ONBOARDING=1`), `auth: "none"` (true BYOK/logged-out — no
  `alpha-auth.json` written, confirmed by `secretHygiene.authMode: null` in every sample),
  synthetic `DEEPSEEK_API_KEY` only. Only the remote Alpha HTTP endpoints are replaced with a
  loopback server; account and bearer request counts are asserted **0** across all 26 samples.
- `startupMs` is the on-disk startup-timeline event `renderer.home.model_list.end{outcome:"ok"}`
  timestamp, read from the timeline file — never derived from a CDP round trip.
- Quiescence gate honored: every launch happened while
  `IOConsoleUsers[0].CGSSessionScreenIsLocked == true`, polled every 20 s throughout. When the
  screen unlocked at 04:44:40 local, a fourth run that had just started was **aborted within
  seconds** and its launched app processes killed; see "Run D (aborted)" below.

### Three runs, and why

| run | samples | purpose |
| --- | --- | --- |
| A | 1 | First-ever launch of this freshly signed binary → AC1b. Aborted afterwards by a probe defect (below); the measurement itself completed and is on disk. |
| B | 13 | First full matrix. |
| C | 13 | Confirmatory matrix, because run B's sample 1 (7,277.7 ms) was an unexplained outlier against its own 3.7–4.2 s band and one run could not distinguish "per-run warm-up" from "real tail". |

Runs B and C are pooled for AC1a. Run C is what made the result trustworthy — see the header note.

## AC1a — steady catalog-ready P95: **FAIL**

Pooled, per-run samples 2–13 (the #1053 convention: each run's sample 1 excluded as a warm-up
marker), n = 24:

| stat | value (ms) |
| --- | ---: |
| min | 3,663.4 |
| median | 3,979.1 |
| max | 55,698.0 |
| **P95 (nearest-rank, k=⌈0.95×24⌉=23)** | **31,966.5** |
| gate (owner, 2026-08-10) | ≤ 5,000 |
| **verdict** | **FAIL** |

**The verdict does not depend on how "steady" is defined.** Pooling all 26 samples including each
run's sample 1 gives the identical P95 of **31,966.5 ms** (k=⌈0.95×26⌉=25). 7 of 24 steady samples
(9 of 26 overall) exceed the gate.

Sorted steady samples (ms):
`3663.4, 3826.3, 3865.2, 3893.5, 3905.8, 3921.6, 3929.2, 3954.7, 3962.3, 3967.4, 3968.6, 3976.4,
3981.9, 3982.5, 3987.0, 3992.1, 4203.3, 7270.0, 7294.4, 7338.2, 31958.0, 31959.0, 31966.5, 55698.0`

Per-run, for transparency about the variance:

| run | n (samples 2–13) | min | max | P95 | verdict alone |
| --- | ---: | ---: | ---: | ---: | --- |
| B | 12 | 3,663.4 | 4,203.3 | **4,203.3** | PASS |
| C | 12 | 3,893.5 | 55,698.0 | **55,698.0** | FAIL |

Full per-sample rows: [`results/results-runB.json`](./results/results-runB.json),
[`results/results-runC.json`](./results/results-runC.json).

## AC1b — first-install sample: 18,179.5 ms

Run A, the first-ever launch of this binary on this machine:
`renderer.home.model_list.end{outcome:"ok"}` at **18,179.5 ms**, first `model.list` count = 2.
Per the parent ticket this value has **no pass/fail threshold** (owner TBD); this run supplies the
number. Raw timeline: [`results/first-install-timeline.jsonl`](./results/first-install-timeline.jsonl).

For reference, #1053's first-install sample was 18,478.9 ms — statistically indistinguishable.
#1056 did not change the first-install path.

Run A's timeline also shows `renderer.composer.mount` firing **twice** (occurrence 1 at 13,436 ms,
occurrence 2 at 18,173 ms) on the first-ever launch, with the first chain ending `cancelled` at
4,702 ms. So the launch path's double mount is still observable on a true first install — it is
just no longer the dominant cost in the steady regime.

## Governed row-count assertion: **PASS**

All 26 samples' first `model.list` read returned exactly **2 rows** — never the ungoverned 6,132-row
snapshot the original #857 bug exposed. `accountRequests = 0` and `bearerRequests = 0` across all
26, i.e. the logged-out path made no account or bearer-credentialed calls.

As in #1053, hot-vs-first equality is **not** independently re-verified this run (the probe's
reload-based hot re-check remains disabled); `modelSet.hotSha256` carries the
`not-computed:req1053-skipped-reload-hot-recheck` marker.

## What the tail actually is

Every slow sample has the same shape, and it is not noise. The two populations separate cleanly:

**Fast regime (20/26 samples).** One `renderer.home.model_list.start`, one `ok` end 5–19 ms later.
`renderer.home.catalog_ready` fires with `barrierMs` 2–15 ms, `probes: 1`, `pollWaits: 0`,
`wake: "first"`. All the wall-clock is spent *before* the chain starts (2.5–2.8 s after
`renderer.root.mount` in the 3.9 s band, 6.1 s in a secondary ~7.3 s band that 4 samples land in).

**Slow regime (6/26 samples, all in run C).** Example, run C sample 1 (`startupMs` 31,941.8 ms):

```
   1162.9  renderer.root.mount                 occurrence 1
  13219.3  renderer.home.model_list.start      attempt 1, chain 1
  23220.3  renderer.home.model_list.end        durationMs 10002.8  outcome "error:request"
  24223.0  renderer.home.model_list.retry_tick attempt 2, delayMs 1000, reason "request-error"
  24224.1  renderer.home.model_list.start      attempt 2, chain 1
  31914.6  renderer.home.model_list.end        durationMs  7671.3  outcome "cancelled"
  31937.5  renderer.home.model_list.start      attempt 1, chain 1     <- attempt counter reset
  31939.9  renderer.home.catalog_ready         barrierMs 3, probes 1, wake "first"
  31941.8  renderer.home.model_list.end        durationMs     4.8  outcome "ok"   count 2
```

Three facts matter here:

1. **`outcome: "error:request"` is now unambiguous.** #1056 split cancellation from failure
   (`alpha-composer.tsx:1055`, `chainSignal.aborted ? "cancelled" : "error:request"`). So these are
   genuine request failures, not the navigation-cancellations #1056 correctly re-attributed. There
   are **8 such failures across the 6 slow samples, every one of them at 10,002–10,004 ms** — a hard
   10-second budget, not a distribution.
2. **The values are quantized, not scattered.** The four ~31.95 s samples are 31,941.8 / 31,958.0 /
   31,959.0 / 31,966.5 — a 24.7 ms spread across four independent app launches. 55,698.0 ms is the
   same ladder with three timeouts instead of one. This is a deterministic retry ladder.
   #1053's lone outlier was **31,874.5 ms** — the same rung.
3. **`main.sidecar.boot.fork.end` and the `phase: "ready"` emit are constant** at ~897 ms and
   ~970–1,000 ms in *all 26 samples*, fast and slow alike. Main-process boot and sidecar fork are
   not the variable. Everything that varies is downstream, between sidecar-ready and the model list
   actually being servable.

**#1056's premise was partly right and partly not.** Its commit message argued the 10 s client
budget explanation "只在 13 个样本里的 2 个成立" and that the real mechanism was
cancellation-by-navigation. The cancellation mechanism is real and #1056 fixed it — that is why 20
of 26 samples now have exactly one chain. But the 10-second failure path was not an artifact of the
mislabeling; it is still here, on 6 of 26 samples, now correctly labeled.

`attempt` resetting to 1 after the cancelled chain (the third `start` above) is consistent with a
second composer instance, since `chainSeq`/`attempt` are instance-local — but this run **cannot
prove it**, because `renderer.composer.mount` was filtered out of the probe's stored event
allowlist. `mounts` in `results.json` counts `renderer.root.mount` (it is 1 in every sample, i.e.
no page-level remount) and is **not** a measurement of #1056's subject. That gap is now fixed in
`probe.ts` (see below) but was not exercised.

## Probe changes made for this run (committed, disclosed)

Three changes to `docs/verification/2026-08-06-req109-110-t7-runtime/probe.ts`:

1. **Refuse to attach to a foreign CDP target.** This machine had an unrelated
   `/Applications/alpha-code.app` (owner's, running 3 days, `ALPHA_CDP=1`) already listening on the
   probe's single hardcoded CDP port 9222. `connectCdp()` picks the first `oc://` page it finds and
   cannot tell whose it is, so the probe would have minimized, screenshotted and `eval`'d — including
   `location.reload()` on the modelSet hot path — **into somebody else's live app**, and reported
   renderer facts describing the wrong binary. The probe now checks whether 9222 was already serving
   targets *before* it launched and, if so, refuses to attach at all
   (`cdpAttachment: "refused-foreign-port"` in every sample of this run). The owner's app was left
   running and untouched.

   This is very likely also the true cause of #1053's unexplained CDP symptoms (screenshots that
   "never settle while minimized", post-reload `eval` hanging 5+ minutes) — that run recorded the
   same `/Applications` instance as already running.

2. **An absent CDP read is reported as `null`, not as a clean `false`.** `tokenInAuthState`,
   `tokenInRendererSurface`, `byokKeyInAuthState`, `byokKeyInRendererSurface` and
   `unavailableVisible` previously fell back to `false`/`false`-ish when their CDP call failed —
   serializing a check that never ran as a passing result. They are now `null` when unread. The
   hygiene checks that do **not** depend on CDP (`tokenInTimeline`, `refreshTokenInTimeline`,
   `tokenInProcessEnv`, `byokKeyInTimeline`, `authMode`) genuinely ran and are clean in all 26
   samples.

3. **`renderer.composer.mount` and `main.sidecar.catalog_liveness.confirmed` added to the stored
   event allowlist, plus a `composerMounts` count.** Added after runs B and C had already been
   captured, so **this run does not exercise it**; it exists so the next recheck can measure #1056's
   actual subject instead of inferring it.

Change 1 also surfaced a latent crash: with `auth` undefined, `JSON.stringify(auth).includes(...)`
threw and killed the whole matrix. That is what aborted run A after its (completed) first-install
measurement.

## Conditions disclosed

- **A foreign process burned one full core throughout every run.** PID 86467, a `/bin/zsh` at 100 %
  CPU with 1 d 3 h uptime, orphaned from a dead Claude session — a poller whose guard clause is a
  Linux-ism (`[ ! -e /proc/self ]`, always true on macOS) that inverts into a tight spin loop. It was
  **left running deliberately**: runs B and C had to be measured under identical conditions for the
  cross-run comparison to mean anything. It was present during #1053 as well.
- **Load was sampled every 10–15 s throughout runs C and D** and stayed at 3.3–4.3 (1-min average)
  with no external spikes; the ~32 s samples do **not** coincide with any load excursion
  ([`results/runC-loadsamples.log`](./results/runC-loadsamples.log)).
- A peer session ran two full alpha-code test suites at 04:22–04:25 and 04:27–04:30 local. Those
  windows fall entirely inside this run's **packaging** step; the first sample of the first probe run
  started at 04:31:08. A short-lived third-party `pytest` was observed at 04:34:35 (not an
  alpha-code test). Neither overlaps a slow sample.
- `models.dev/api.json` was reachable (HTTP 200, 1.05 s) when checked at 04:38 local.

## Run D (aborted — disclosed, not hidden)

A fourth 13-sample run was launched at 04:44:40 local to measure `composerMounts` directly. The lock
monitor reported the screen **unlocked** at that same second (confirmed twice, 3 s apart). Per this
job's quiescence rule the run was aborted immediately: probe killed, its 6 launched app processes
killed, its temp root removed. It produced no samples and no data is drawn from it. The screen
re-locked shortly after; **no further probe launches were made**, because the verdict does not depend
on run D — it would only have upgraded the double-mount inference above from inference to
measurement.

## Limitations

- Composer mount count for runs B/C is **inferred** from the `attempt` counter reset, not measured
  (see above).
- No screenshots and no renderer-side `eval` facts this run — CDP was deliberately refused.
- Hot-vs-first model-set equality not independently re-verified (same as #1053).
- Root cause of the 10 s failure path is **not** established here. This is a VERIFY; the tail is
  characterized, not diagnosed.

## Recommended CODE follow-up (not implemented in this VERIFY)

1. Find what makes the model-list request fail after exactly ~10 s on ~23 % of cold starts. The
   renderer's `error:request` is the symptom; the budget and the failing hop are downstream of
   `main.sidecar.generation.emit{phase:"ready"}`, which is constant at ~970 ms in fast and slow
   samples alike. Note `phase:"ready"` demonstrably does **not** mean "model list is servable".
2. Explain the two-tier fast regime (~3.9 s vs ~7.3 s, both single-chain, both with a sub-20 ms
   barrier). Even the fast tier spends 2.5–2.8 s after `renderer.root.mount` before the chain starts —
   with a 5,000 ms gate, that is over half the budget before the first request is issued.
3. Re-run this exact probe with **at least two independent 13-sample matrices** before re-closing
   AC1a. One matrix cannot see this tail: run B alone would have reported PASS.

## Non-goals honored

- No product AC rewritten.
- No push, no PR, no Issue/Project mutation. Local commit only.
- The owner's running `/Applications/alpha-code.app` was not quit, reloaded, or otherwise touched.
- The app was never installed over `/Applications`.
