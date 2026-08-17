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
the selected entry and the user's grants. `{workspace}` was already the catalog's explicit directory
grant. REQ-133 adds `{alphaResources}`, which main alone replaces with the packaged resource root.
The packaged file is `resources/office-mcp/server.py`; a catalog cannot choose another host resource
root through either placeholder.

The production MCP write choke point is `applyMcpWritePolicy`. Before REQ-133 it only provisioned and
checked the community `excel-mcp-server`. Bundle and seed planning repeated that fact as a literal
`"excel-mcp-server"` exception. The policy membership is now derived from the office connector
registry, so all four Alpha connectors take the same main-side path canonicalization and bundle/seed
fail-closed treatment without four more package-name holes.

The archived `office-word-mcp-server` and `office-powerpoint-mcp-server` advisories remain in force,
including their old `mcp:word` and `mcp:powerpoint` ids. The existing `mcp:excel` /
`excel-mcp-server@0.1.8` record remains a community connector governed by REQ-103 and REQ-105. It is
not renamed, relabelled, or made the implementation of the Alpha Excel card. The checked-in
`alpha-catalog.json` is a generated/offline snapshot and is not edited by this decision.

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
carry a workspace grant and therefore rejects these members rather than persisting an unsandboxed
config. The former community Excel card may coexist as legacy catalog history, but the four-card
Alpha Office shelf points at the four new ids above and never rewrites its authorship.

Third-party pinned intake (option A) is rejected for the card surface: it would retain four external
MCP maintenance and transport contracts and would contradict the owner decision that the wrappers
are Alpha-authored. A split markitdown-read plus separate writer default (option C) is rejected
because each card must independently provide its format's read and write capability. Markitdown
remains an optional, secondary read/conversion connector.

## Security invariants

- The only runtime transport is newline-delimited JSON-RPC over process stdin/stdout. The server CLI
  accepts exactly `<format> <absolute-workspace>`; it has no host, port, SSE, HTTP, or
  streamable-HTTP mode.
- Main replaces `{alphaResources}` and `{workspace}`, then the MCP write policy canonicalizes the
  packaged server file and existing granted directory before durable config is committed. Missing
  resources or directories fail closed.
- Every tool call requires an absolute path with the selected extension, rejects any literal `..`
  segment, resolves existing symlink components, and requires the result to remain below the
  canonical workspace root. The server never receives a general host filesystem root.
- `office-advisories` accepts only the registry's exact `uv run --no-project`, dependency pins,
  bundled script, format mode, and workspace command shape. Remote configs, URLs, extra transport or
  host/port args, network-binding environment variables, `0.0.0.0`, relative paths, traversal, and
  dependency drift fail loudly. Dependency upgrades require a new intake and pin change.
- The old archived Word/PowerPoint packages and ids stay denied. The old community Excel safety pin
  remains separate; adding Alpha Excel must not collapse source, author, receipt, or provenance.
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
