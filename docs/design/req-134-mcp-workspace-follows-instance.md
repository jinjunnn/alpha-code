---
title: REQ-134 Catalog MCP workspaces follow the current instance
kind: design
status: accepted
owners:
  - alpha-code product and security maintainers
last_reviewed: 2026-08-17
review_after: 2027-02-13
---

# REQ-134 Catalog MCP workspaces follow the current instance

Parent requirement: [jinjunnn/alpha-code#1010](https://github.com/jinjunnn/alpha-code/issues/1010).
Implementation: [jinjunnn/alpha-code#1011](https://github.com/jinjunnn/alpha-code/issues/1011).

## Ground truth

Catalog installation is global. Before REQ-134, the Hub asked for a directory and replaced
`{workspace}` while installing a local MCP, so the selected host path became part of the global
durable command. Opening another project changed the engine instance directory but did not change
that command; the connector therefore remained sandboxed to the installation-time project.

`InstanceState.directory` is the engine's authoritative directory for the instance that is about to
spawn a local stdio MCP. The local transport already uses that value as its child-process `cwd`.
Binding the workspace argument at that same choke point keeps one global installation while making
the server's filesystem root follow the current instance. It does not require project-scoped
receipts, per-project reinstall, or durable config rewrites on session switches.

The community Excel connector is retired by REQ-135. This decision does not restore
`excelWorkspaceRoot`, `EXCEL_FILES_PATH`, or `mcp:excel`. Those surfaces are gone; Alpha Excel
uses the same `{workspace}` spawn substitution as the other three Office connectors.

## Selected C

A catalog local-MCP command that declares the exact argument `{workspace}` persists that literal
argument in `mcp.<name>.command`. The Hub neither presents a directory picker nor sends a
`grants.workspace` field. The main install planner derives the command from the verified catalog,
preserves the marker, and rejects `grants.workspace` as an unknown grant.

Immediately before constructing `StdioClientTransport`, `connectLocal` maps each command argument
equal to `{workspace}` to the current `InstanceState.directory`. It does not perform substring
replacement: `prefix-{workspace}`, `{workspace}/child`, and every other argument reach the child
unchanged. The instance directory must already be available; there is no home-directory,
process-working-directory, or filesystem-root fallback.

For the four Alpha Office connectors, install policy still canonicalizes the bundled
`resources/office-mcp/server.py` path but requires the workspace slot to remain `{workspace}`. The
server itself is unchanged: at spawn it still receives one concrete absolute workspace and applies
its existing containment checks to every tool path.

## Security and migration invariants

- The only marker substitution occurs in the engine's local stdio spawn path, after instance
  selection and before transport construction. Exact tokens only are eligible.
- Durable catalog configuration contains no installation-time host directory. Custom MCP commands
  remain user-owned and are never rewritten merely because an argument looks like a path.
- Boot reconciliation runs before the first local server spawn. It recognizes only the exact
  catalog templates for the four Alpha Office commands and the bundled `mcp:filesystem` and
  `mcp:git` commands. Within those templates, an absolute concrete workspace argument is restored
  to `{workspace}`.
- Template drift, version-pin drift, additional or missing arguments, relative workspace paths,
  remote MCPs, and non-catalog/custom entries are byte-for-byte preserved. Reconciliation is
  idempotent.
- Alpha Office path safety continues to reject access outside the concrete workspace delivered at
  spawn. REQ-135 already deleted the community Excel managed-root policy; this marker cannot
  recreate it.
- Bundle and seed workspace-policy exceptions, project-scoped receipts, alpha-web catalog
  publication, wrappers, and server tool changes are outside this decision.

## Ownership and evidence

The implementation child owns the engine substitution, Hub and planner transport removal, Office
policy compatibility, boot migration, source-order anchor, and deterministic tests. Its pull request
closes only `jinjunnn/alpha-code#1011` and references the parent without closing it.

Evidence is split at the behavior choke points: real stdio lifecycle tests observe child argv;
planner and policy tests observe the durable marker and unknown-grant refusal; the Hub component test
observes zero directory-picker calls; migration tests cover the exact whitelist, untouched cases,
and idempotence; Office tests retain in-root success and outside-root refusal. The parent requirement
remains manually accepted and closed by its owner.
