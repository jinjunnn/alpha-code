---
title: REQ-090 Alpha Recovery L2 static verification
kind: verification
status: active
owners:
  - alpha-code frontend
last_reviewed: 2026-07-21
review_after: 2026-10-21
---

# REQ-090 Recovery L2 static harness

This record verifies the approved Recovery frame without launching Electron, a browser, headless
runtime, Playwright, or screenshot tooling.

## Matrix

[`harness.html`](harness.html) contains the four required failure presentations in both the light
and dark Alpha token palettes:

| Failure partition               | Stable renderer fact        | Action evidence                                 |
| ------------------------------- | --------------------------- | ----------------------------------------------- |
| Configuration / data corruption | `RECOVERY_DATABASE_CORRUPT` | restore when available, exit, explicit continue |
| Sidecar / network failure       | `RECOVERY_ENGINE_STOPPED`   | retry engine                                    |
| Surface crash, record saved     | `RECOVERY_SURFACE_CRASHED`  | no invented action; region remains isolated     |
| Surface crash, save failed      | `RECOVERY_SURFACE_CRASHED`  | retry failure-record save only                  |

The harness uses fixed safe data. It deliberately contains no path, backup name, migration ID,
surface ID, exception text, stack, or secret value.

## Boot ordering evidence

The production order in `packages/ui-mac/src/main/index.ts` is:

1. create the process-local Recovery service and register its IPC handlers;
2. run `runDbPreflightBoot(...)`;
3. when DbSafety returns a recovery plan, create the dedicated Recovery window and await one applied
   adapter action;
4. only after preflight proceeds, spawn/settle the sidecar and call `createMainWindow()`.

`packages/ui-mac/src/main/recovery-wiring.test.ts` ratchets that `runDbPreflightBoot(...)` appears
before `mainWindow = createMainWindow()`, that startup DbSafety branches contain no native message
box, and that the Recovery window uses `preload/recovery.js` with context isolation, sandboxing,
Node integration disabled, and webview disabled.

## Inspection

The harness is a static review artifact. Open it only in an ordinary browser if a future reviewer
chooses to inspect it manually; no browser or screenshot was started for this delivery.
