---
title: REQ-133 Alpha first-party four-format Office connectors
kind: design
status: accepted
owners:
  - alpha-code product and security maintainers
last_reviewed: 2026-08-17
review_after: 2027-02-13
---

# REQ-133 Alpha first-party four-format Office connectors

Parent requirement: [jinjunnn/alpha-work#64](https://github.com/jinjunnn/alpha-work/issues/64). Decision:
[jinjunnn/alpha-code#1005](https://github.com/jinjunnn/alpha-code/issues/1005). Implementation:
[jinjunnn/alpha-code#1006](https://github.com/jinjunnn/alpha-code/issues/1006).

## Ground truth

The Hub does not manufacture install facts in the renderer. A verified signed catalog entry supplies
the id, name, source, and local MCP command; the main-only planner re-derives the durable config from
the selected entry and the user's grants. `{workspace}` is the catalog's explicit runtime workspace
marker; [REQ-134](req-134-mcp-workspace-follows-instance.md) keeps it in durable config and binds it
to the current instance directory at stdio spawn. REQ-133 adds `{alphaResources}`, which main alone
replaces with the packaged resource root. The packaged file is `resources/office-mcp/server.py`; a
catalog cannot choose another host resource root through either placeholder.

The production MCP write choke point is `applyMcpWritePolicy`. Before REQ-133 it only provisioned and
checked the community `excel-mcp-server`. Bundle and seed planning repeated that fact as a literal
`"excel-mcp-server"` exception. The policy membership is now derived from the office connector
registry, so all four Alpha connectors take the same main-side path canonicalization and bundle/seed
fail-closed treatment without four more package-name holes.

The archived `office-word-mcp-server` and `office-powerpoint-mcp-server` advisories remain in force,
including their old `mcp:word` and `mcp:powerpoint` ids. At REQ-133 acceptance, the existing
`mcp:excel` / `excel-mcp-server@0.1.8` record remained a separate community connector; REQ-135 now
supersedes that coexistence and retires it without renaming, relabelling, or making it the
implementation of the Alpha Excel card. The checked-in `alpha-catalog.json` is a generated/offline
snapshot and is not edited by either decision.

## Selected B

Alpha owns one small raw-stdio MCP server with four format entry modes. The wrappers call the locked
file libraries directly and do not require Microsoft Office. The web catalog must use `source:
"alpha"`; receipt-derived runtime ownership may therefore report `authored=alpha`, while every other
REQ-103 ownership/provenance dimension remains independently derived.

The catalog ids, server names, tools, pins, and exact command arrays are one mapping:

| Card       | Catalog id / server name                    | Primary tools                                                    | Exact local MCP command array                                                                                                                  |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Word       | `mcp:alpha-word` / `alpha-word`             | `read_docx`, `write_docx` via `python-docx==1.2.0`               | `["uv","run","--no-project","--with","python-docx==1.2.0","{alphaResources}/office-mcp/server.py","word","{workspace}"]`                       |
| Excel      | `mcp:alpha-excel` / `alpha-excel`           | `read_xlsx`, `write_xlsx` via `openpyxl==3.1.5`                  | `["uv","run","--no-project","--with","openpyxl==3.1.5","{alphaResources}/office-mcp/server.py","excel","{workspace}"]`                         |
| PowerPoint | `mcp:alpha-powerpoint` / `alpha-powerpoint` | `read_pptx`, `write_pptx` via `python-pptx==1.0.2`               | `["uv","run","--no-project","--with","python-pptx==1.0.2","{alphaResources}/office-mcp/server.py","powerpoint","{workspace}"]`                 |
| PDF        | `mcp:alpha-pdf` / `alpha-pdf`               | `read_pdf`, `write_pdf` via `pypdf==6.16.1` + `reportlab==5.0.0` | `["uv","run","--no-project","--with","pypdf==6.16.1","--with","reportlab==5.0.0","{alphaResources}/office-mcp/server.py","pdf","{workspace}"]` |

These are the exact commands the alpha-web catalog cards should copy. Each card is independently
installable. A bundle may reference them later, but phase-one atomic bundle/seed installation cannot
install workspace-policy members and therefore rejects these commands rather than bypassing their
sandbox contract. The former community Excel coexistence allowance is superseded by
[REQ-135](req-135-retire-community-excel.md): the four-card Alpha Office shelf points at the four new
ids above, and Hub Excel is `mcp:alpha-excel` only.

Third-party pinned intake (option A) is rejected for the card surface: it would retain four external
MCP maintenance and transport contracts and would contradict the owner decision that the wrappers
are Alpha-authored. A split markitdown-read plus separate writer default (option C) is rejected
because each card must independently provide its format's read and write capability. Markitdown
remains an optional, secondary read/conversion connector.

## Security invariants

- The only runtime transport is newline-delimited JSON-RPC over process stdin/stdout. The server CLI
  accepts exactly `<format> <absolute-workspace>`; it has no host, port, SSE, HTTP, or
  streamable-HTTP mode.
- Main replaces `{alphaResources}`, canonicalizes the packaged server file, and requires the
  workspace command slot to remain exactly `{workspace}` before durable config is committed. At
  stdio spawn, the engine replaces that exact argument with the current `InstanceState.directory`;
  a missing instance directory fails closed.
- Every tool call requires an absolute path with the selected extension, rejects any literal `..`
  segment, resolves existing symlink components, and requires the result to remain below the
  canonical workspace root. The server never receives a general host filesystem root.
- `office-advisories` accepts only the registry's exact `uv run --no-project`, dependency pins,
  bundled script, format mode, and either the durable `{workspace}` marker or the exact absolute
  workspace supplied to its runtime safety check. The main write policy narrows durable commands to
  the marker. Remote configs, URLs, extra transport or host/port args, network-binding environment
  variables, `0.0.0.0`, relative paths, traversal, and dependency drift fail loudly. Dependency
  upgrades require a new intake and pin change.
- The old archived Word/PowerPoint packages and ids stay denied. REQ-135 retires the separate
  community Excel pin; Alpha Excel still must not collapse its source, author, receipt, or provenance.
- PDF write is bounded to textual document replacement/generation and appending text pages. It is
  not a layout designer, print-fidelity editor, Office converter, digital-signature tool, or arbitrary
  PDF object editor.

## Child split

The parent requirement remains the acceptance owner's manual close and is never a PR `Fixes`
target. The DECIDE child owns this accepted four-section baseline. The alpha-code CODE child
`jinjunnn/alpha-code#1006` owns the bundled server, packaged-resource wiring, main install/write
policy, office advisory gates, `office-docs`, and deterministic local tests; its PR uses `Fixes
jinjunnn/alpha-code#1006` and `Refs jinjunnn/alpha-work#64`.

The alpha-web CODE child linked from the parent owns four signed catalog entries, `source: "alpha"`,
curation/intake decisions, shelf visibility, glyph/source presentation, and catalog guards. It copies
the command arrays above and publishes through the catalog workflow; alpha-code does not hand-edit or
sync the generated snapshot in this change. The VERIFY child owns the installed Hub matrix and the
capability fixtures for create/read/edit plus the negative transport/path matrix. Neither CODE child
claims requirement completion, and neither closes the parent.
