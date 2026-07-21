---
title: alpha-code design asset index
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Design assets

This directory holds alpha-code's product design in **two layers** plus a map
that ties them together. Current *behavior* is still decided by code, tests,
accepted ADRs, and active contracts; GitHub Issues own remaining work. These
files decide *design intent*, not runtime truth.

Start at **[`PAGE-MAP.md`](PAGE-MAP.md)** — it lists every real product surface,
whether that surface is still inherited from upstream opencode or has been
alpha-ized, and where its current design lives.

## The two layers

| Layer | Path | What it is | Mutable? |
| --- | --- | --- | --- |
| **Current** | [`current/<page>/design.html`](current/) | The living design for one page. Edit this in place when a page gains or changes content. One file per surface. | Yes — this is the working copy. |
| **History** | dated dirs (`2026-…/`), `debates/`, top-level `*.md` | Frozen snapshots and proposals — the decision record of how each surface reached its current form. | No — append-only. |

A `current/<page>/design.html` is seeded from the latest approved dated snapshot
and then edited forward. The dated snapshot it came from stays frozen: it is the
record of what was approved at that date, complete with its authored-time status
tables, TODOs, and rollout phases. Do not "update" a dated snapshot to reflect
today — that is what `current/` is for.

## Workflow

1. **Changing an existing page?** Edit `current/<page>/design.html` directly.
   Git history is the fine-grained record between approvals.
2. **Reaching an approval milestone / shipping a redesign?** Cut a new dated
   snapshot from the current file (`2026-…-<name>/`) so the approved state is
   frozen, and update the page's row in `PAGE-MAP.md`.
3. **New surface with no design yet?** Add its row to `PAGE-MAP.md` first
   (status + owning REQ), then create `current/<page>/` when design starts.

Some latest drafts may be in flight in another repo/worktree and not yet
committed here — `PAGE-MAP.md` marks those so `current/` is never seeded from
unlanded work.

## Design history families

Each family's design lineage. "Current authority" is the current-behavior owner
(code/ADR/contract); the living design intent for the page is under `current/`
and indexed in `PAGE-MAP.md`.

| Family | Design history | Current authority |
| --- | --- | --- |
| Extension Hub / 定制中心 | `extension-hub.md` → `2026-06-22-arch-extension-hub.md` → `2026-07-04-extension-hub-v3-universal.md` → `2026-07-13-req103-hub-governance/` (治理三归位 v3) → `2026-07-15-capability-authorize-dialog/` (authorize 确认框增量) → `2026-07-17-req103-remaining/` (scope 分组做实 + 已授权能力段 v4) → `2026-07-17-req104-pack-facts/` (Pack 整包事实 + 第三方默认关 v5) → `2026-07-18-req104-four-shelf/` (四级货架 v6) | current extension code/tests and ADR-014/ADR-028/ADR-030 |
| Alpha system surfaces | `2026-07-20-req090-alpha-surfaces/` (Settings / Permission / Model / Dialog / Recovery bundle) | current alpha-ui code and REQ-090 |
| Product visual language | `2026-06-25-cool-graphite-visual-system.md` plus protected prototypes under `docs/archive/assets/design-program/` | current UI tokens, components, and visual tests |
| Frontend/upstream boundary | `2026-07-03-frontend-decoupling-options.md` | `docs/architecture/upstream-integration.md`, sync workflows, ADR-020/ADR-029 |
| Alpha extension storage | `2026-07-07-project-alpha-only-extensions.md` | current installer/config code and ADR-019 |
| Safety and curation | `2026-07-05-db-safety-belt.md`, `2026-07-09-supply-baseline-curation-proposal.md` | current code, tests, signed Catalog contracts, and accepted ADRs |
| Challenges | `debates/` | immutable design-review context only |

Architecture diagrams are indexed separately under
`../architecture/diagrams/`. Superseding a dated snapshot requires an explicit
link; age or an absent runtime reference never authorizes deleting a design
asset.
