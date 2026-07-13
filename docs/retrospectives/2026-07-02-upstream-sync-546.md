# Upstream sync retro — origin/dev → upstream/dev (546 commits), 2026-07-02

First real exercise of the ADR-004 upgrade runbook. The nightly `sync-upstream` bot had been
failing for 11+ days (B19: default `GITHUB_TOKEN` can't push `.github/workflows/*` changes), so the
fork had drifted **546 commits** behind `anomalyco/opencode:dev`. Ran the catch-up manually (local gh
token has `workflow` scope).

## North star: held
- `git merge dev → alpha`: **zero conflicts** (not even `bun.lock`). The only-add discipline worked —
  546 commits of upstream file changes merged cleanly; alpha modifies no upstream files.
- Post-merge guard: `git diff --diff-filter=DMR dev alpha -- packages/{opencode,core,server,app,ui,tui,sdk}` = **empty**.

## Contract adaptation required (the point of the runbook)
`tsgo` surfaced 5 errors — upstream consolidated the WSL platform contract (`@opencode-ai/app`
`WslServersPlatform` / `WslJob`): per-distro `probeDistro` + `probeOpencode` → one batch
`probeAddable(distros: string[])` (job `probe-addable`). Adapted alpha's own WSL backend:
- `packages/ui-mac/src/main/wsl/servers.ts` — merged the two methods into `probeAddable` (loop: probe
  distro + refresh opencode check per distro; idempotent).
- `packages/ui-mac/src/main/wsl/ipc.ts` — `wsl-servers-probe-{distro,opencode}` channels → one
  `wsl-servers-probe-addable` (both the win32 and the non-Windows "unavailable" branch).
- `packages/ui-mac/src/preload/index.ts` — bridge method `probeDistro/probeOpencode` → `probeAddable`.
WSL is Windows-only (dormant on this Mac app); adaptation is contract-conformance, not behavior.

## ADR-015 prompt-base merge-verify: no conflict
The sync touched the prompt base — reviewed per ADR-015:
- `packages/opencode/src/agent/agent.ts` (46 lines): **internal Effect DI refactor** only
  (`LocationServiceMap` → `.Service` + `locationServiceMapLayer`, `PluginBoot` → `PluginV2`, layer-node
  shape). No change to prompt content or agent instructions.
- `packages/opencode/src/session/prompt/max-steps.txt`: **deleted**; not referenced anywhere in alpha.
Alpha's Tier-3 layers (`alpha-behavior.ts` answer-length calibration, `alpha-identity.ts` capability
facts) are orthogonal to a DI refactor → **no semantic conflict**. Layers left unchanged.

## Verification
`bun install` (76 pkgs, clean) · ui-mac + ext `tsgo` exit 0 · `bun test` 71 pass/0 fail · north-star
guard empty · ADR-015 review above · isolated dev boot smoke.

## Follow-up
B19 automation still needs a `SYNC_TOKEN` PAT (`workflow` scope) if the nightly bot should self-heal;
manual sync (this retro) is the fallback and works.
