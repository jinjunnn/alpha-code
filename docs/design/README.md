---
title: alpha-code design asset index
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-13
review_after: 2027-01-09
---

# Design assets

This directory preserves approved product designs, proposals, visual systems,
and design-review debates. It is a design-history corpus, not a `latest`
implementation specification. Current behavior is decided by code, tests,
accepted ADRs, and active contracts; GitHub Issues own remaining work.

## Current reference versus design history

There is no single current design file in this directory. A dated design is a
current reference only for the constraint that a current ADR, contract, or
implementation explicitly cites. Its embedded status tables, TODOs,
checklists, line numbers, and rollout phases remain authored-time history.

| Family | Design history | Current authority |
| --- | --- | --- |
| Extension Hub | `extension-hub.md` → `2026-06-22-arch-extension-hub.md` → `2026-07-04-extension-hub-v3-universal.md` → `2026-07-13-req103-hub-governance/` (治理三归位 v3) → `2026-07-15-capability-authorize-dialog/` (authorize 确认框增量) → `2026-07-17-req103-remaining/` (scope 分组做实 + 已授权能力段 v4,approved 2026-07-17) | current extension code/tests and ADR-014/ADR-028/ADR-030 |
| Product visual language | `2026-06-25-cool-graphite-visual-system.md` plus protected prototypes under `docs/archive/assets/design-program/` | current UI tokens, components, and visual tests |
| Frontend/upstream boundary | `2026-07-03-frontend-decoupling-options.md` | `docs/architecture/upstream-integration.md`, sync workflows, ADR-020/ADR-029 |
| Alpha extension storage | `2026-07-07-project-alpha-only-extensions.md` | current installer/config code and ADR-019 |
| Safety and curation | `2026-07-05-db-safety-belt.md`, `2026-07-09-supply-baseline-curation-proposal.md` | current code, tests, signed Catalog contracts, and accepted ADRs |
| Challenges | `debates/` | immutable design-review context only |

Architecture diagrams are indexed separately under
`../architecture/diagrams/`. Superseding a design requires an explicit link;
age or an absent runtime reference never authorizes deleting the design asset.
