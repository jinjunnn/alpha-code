---
title: alpha-code design asset index
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-29
review_after: 2027-01-16
---

# Design assets

This directory holds alpha-code's product design in **three layers** plus a map
that ties them together. Current *behavior* is still decided by code, tests,
accepted ADRs, and active contracts; GitHub Issues own remaining work. These
files decide *design intent*, not runtime truth.

Start at **[`PAGE-MAP.md`](PAGE-MAP.md)** — it lists every real product surface,
whether that surface is still inherited from upstream opencode or has been
alpha-ized, and where its current design lives.

## The three layers

| Layer | Path | What it is | Mutable? |
| --- | --- | --- | --- |
| **Current** | [`current/<page>/design.html`](current/) + `design.css` | The living design for one page. Edit this in place when a page gains or changes content. One page, one file. | Yes — this is the working copy. |
| **Components** | `current/<page>/components.md` | One row per component on that page: its anchor, the increment that introduced it, approval date, implementation issue, landed date, code entry. | Yes — a ledger, appended and completed. |
| **History** | dated dirs (`2026-…/`), `debates/`, top-level `*.md` | Frozen snapshots and proposals — the decision record of how each surface reached its current form. | No — append-only. |

Markup and styling are split: `design.html` carries the frames, `design.css`
carries that page's styles, linked from the same directory. Read the markup
without paying for the stylesheet; editing a frame rarely needs the CSS at all.
The split is positional only — the `<link>` sits exactly where the old `<style>`
did, so the cascade is unchanged.

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

## Adding a component to an existing page

The workflow above covers whole pages. Most real work is smaller: one new
component on a page that already has a design. Copying the whole page into a
dated snapshot to show one new row wastes both the reviewer's attention and the
repository (REQ-124 spent 41 KB duplicating the timeline to introduce a single
artifact row). Do this instead:

1. **`PAGE-MAP.md` does not change.** A leaf control is not a surface — the
   surface manifest deliberately refuses to enumerate popovers, tabs, and leaf
   controls, and this file follows it.
2. **Add the row to `current/<page>/components.md` first**, status `设计中`, and
   settle its anchor id there. Everything downstream points at that anchor, so it
   has to exist before anything can reference it.
3. **Draft the increment as that component only** —
   `2026-…-<req>-<component>/frame.html`, a few KB, plus a short `design.md` when
   the rationale runs longer than a screen. Do not restate the page.
4. **On approval**, merge the frame into the matching section of
   `current/<page>/design.html` carrying the anchor from step 2, and fill the
   ledger's approval column. The dated directory freezes as-is — that is the
   archival record, and it is never edited afterwards.
5. **When the implementation issue closes**, the same PR fills the ledger's
   landed and code-entry columns. A component whose ledger row still reads
   `设计中` after its issue closed is the drift this layer exists to surface.

### `components.md` fields

| Field | Meaning |
| --- | --- |
| 组件 | The name used in review conversation. |
| 锚 | `#id` in `design.html`. Must resolve — a ledger pointing at a missing anchor is worse than no ledger. |
| 增量稿 | The dated directory that introduced it, or `—` if it predates this layer. |
| 设计定稿 | Date the frame merged into the living draft. |
| 实现票 | `repo#number`. |
| 落地 | Date the implementation merged, or `—` while open. **Derived from the issue, not asserted by hand** — a hand-kept column goes stale and then reads as truth. |
| 代码入口 | Path under `packages/…` that renders it. |

**A page's design is aligned with its implementation when its ledger has no row
still open.** That is the only definition of "is `current/` current?" this
directory offers; before the ledger existed, the question had no answer.

## Known open decision: token drift

The eleven living drafts do not agree on the design system. Of 105 distinct
custom properties, 16 appear in all eleven, and 27 that appear in four or more
drafts carry conflicting values — `--a-warning` is both `#b45309` and `#d97706`,
`--a-text-tertiary` both `#71727a` and `#7c7d85`, `--a-error-subtle` has three
alpha values.

Converging them changes how some approved drafts look, which is a design
decision and not a cleanup. Until it is taken, treat
`2026-06-25-cool-graphite-visual-system.md` as the intent and each draft's
`design.css` as what that draft actually asserts.

## Design history families

Each family's design lineage. "Current authority" is the current-behavior owner
(code/ADR/contract); the living design intent for the page is under `current/`
and indexed in `PAGE-MAP.md`.

| Family | Design history | Current authority |
| --- | --- | --- |
| Extension Hub / 定制中心 | `extension-hub.md` → `2026-06-22-arch-extension-hub.md` → `2026-07-04-extension-hub-v3-universal.md` → `2026-07-13-req103-hub-governance/` (治理三归位 v3) → `2026-07-15-capability-authorize-dialog/` (authorize 确认框增量) → `2026-07-17-req103-remaining/` (scope 分组做实 + 已授权能力段 v4) → `2026-07-17-req104-pack-facts/` (Pack 整包事实 + 第三方默认关 v5) → `2026-07-18-req104-four-shelf/` (四级货架 v6) → `2026-07-30-req128-extension-package-baseline.md` (标准 package、外部 Plugin 适配与兼容宿主安装) → `2026-08-02-req128-local-plugin-import/` (本地插件包导入的增量提案 — 提案未批,实现先落地;**其数字与状态划分已被上线实况取代,以 `current/customization-center/design.html` 的 §9 为准**) | current extension code/tests and ADR-014/ADR-028/ADR-030 |
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
