---
title: REQ-135 Retire the community Excel connector
kind: design
status: accepted
owners:
  - alpha-code product and security maintainers
last_reviewed: 2026-08-18
review_after: 2027-02-13
---

# REQ-135 Retire the community Excel connector

## Ground truth

Parent requirement: [jinjunnn/alpha-work#65](https://github.com/jinjunnn/alpha-work/issues/65).
Desktop implementation: [jinjunnn/alpha-code#1012](https://github.com/jinjunnn/alpha-code/issues/1012).

Alpha already ships the first-party `mcp:alpha-excel` connector selected by REQ-133. The separate
community `mcp:excel` card installs `excel-mcp-server`; it is neither the implementation nor the
authorship source of Alpha Excel. The portfolio has no tenant migration to preserve, so retaining a
second Excel engine, alias, or compatibility path would create product ambiguity without preserving
a user contract.

The checked-in `packages/ui-mac/src/renderer/extensions/alpha-catalog.json` is a generated offline
snapshot and currently retains `mcp:excel`. Desktop behavior must deny that entry independently of
its snapshot bytes. Catalog removal and the next signed snapshot are owned by
[jinjunnn/alpha-web#155](https://github.com/jinjunnn/alpha-web/issues/155); alpha-code refreshes the
snapshot only through `packages/ui-mac/scripts/sync-catalog-snapshot.mjs`, never by hand.

## Selected retirement

Hub Excel means `mcp:alpha-excel` only. The static retirement facts retain the exact community
catalog id, server name, and package name solely so catalog entry, seed, bundle, signed package,
rollback, and uncurated MCP write paths can refuse new installation or reactivation. They do not
relabel the community package as Alpha, redirect it to the first-party server, or preserve a runnable
compatibility shim.

At boot, Alpha removes only the durable `mcp.excel-mcp-server` config leaf from the live engine
target (`mcpPluginTargetPath()`) and every retained legacy copy the engine still merges
(`~/.opencode` / XDG), plus its matching global receipt. Reconciliation is idempotent: an absent
config or receipt remains absent and does not cause a config file, section, leaf, or replacement
receipt to be created. The mutation waits for extension transaction recovery, holds the global
extension lock, and refuses to run while a non-terminal transaction journal remains; it completes
before the first sidecar fork.

The former write policy that created `~/Alpha/excel-workspace` and injected `EXCEL_FILES_PATH` is
deleted. Retirement does not inspect, copy, migrate, rename, or delete files under that old directory;
in particular, it does not copy them into an Alpha Excel workspace.

## Security invariants

- The first-party `mcp:alpha-excel` command, dependency pin, stdio-only transport, and explicit
  workspace grant remain governed by REQ-133; retirement must not weaken or alias those checks.
- Both the exact `mcp:excel` / `excel-mcp-server` identity and a renamed MCP config whose command
  invokes the retired package **by package-identity form** (`uv`/`uvx` `--with`/`--from=`/`-w`,
  extras, markers, `_`/`.` normalization) fail closed before durable installation. URL tarball and
  `git+` sources are outside this identity matcher; uncurated MCP can still install arbitrary
  software by other means.
- Boot teardown removes only that retired community config leaf — from the live engine target and
  retained merged copies — and the matching global receipt. A parse, write, or receipt failure is
  loud and retried on a later boot rather than broadening the deletion.
- Archived community Word and PowerPoint keep-installed behavior is unchanged. REQ-135 does not
  edit their advisories, receipts, runtime treatment, or user guidance.

## Child split

The parent requirement remains the acceptance owner's manual close and is never a PR `Fixes` target.
The alpha-code child `jinjunnn/alpha-code#1012` owns desktop denial, boot teardown, removal of the old
workspace write policy, factory guidance, durable design, release note, and deterministic tests. Its
PR uses `Fixes jinjunnn/alpha-code#1012` and `Refs jinjunnn/alpha-work#65`.

The alpha-web child `jinjunnn/alpha-web#155` owns removal from the signed catalog; only its signed
output can refresh alpha-code's generated offline snapshot. This desktop child does not edit
alpha-web, implement REQ-134 `{workspace}` spawn behavior, or change the archived Word/PowerPoint
policy.
