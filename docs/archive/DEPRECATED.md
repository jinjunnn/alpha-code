---
title: alpha-code deprecated documentation ledger
kind: audit
status: frozen
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-13
---

# Deprecated documentation

This is the only searchable record of retired alpha-code developer prose.
Active delivery is in [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues)
and [Alpha Delivery](https://github.com/users/jinjunnn/projects/2). Original
content is recoverable at commit
[`3024732c1e8cbc541df67abeea1f5d7693867023`](https://github.com/jinjunnn/alpha-code/tree/3024732c1e8cbc541df67abeea1f5d7693867023/docs).

| Former path or namespace | Class | Disposition | Promoted authority |
| --- | --- | --- | --- |
| `docs/BACKLOG.md`, `docs/harness-extension-backlog.md` | delivery | removed after Issue migration | GitHub Issues and Alpha Delivery |
| `docs/requirements/**`, `docs/sprints/**`, `docs/plans/**` | delivery | removed; no local status mirror remains | GitHub Issues, fixed verification in `docs/audits/` |
| `docs/PROCESS.md` | historical process | retired pre-GitHub workflow | root `AGENTS.md`, portfolio delivery and documentation standards |
| `docs/CHANGELOG.md` | release history | promoted out of `docs/` | root `CHANGELOG.md` |
| `docs/CI.md` | runbook | normalized without loss | `docs/runbooks/ci.md` |
| `docs/DISTRIBUTION.md` | runbook | normalized without loss | `docs/runbooks/distribution.md` |
| `docs/UNINSTALL.md` | runbook | normalized without loss | `docs/runbooks/uninstall.md` |
| `docs/UNDERSTANDING.md` | architecture | normalized without loss | `docs/architecture/understanding.md` |
| `docs/platform-integration.md` | contract | reconciled against current code and producer contracts | `docs/contracts/platform-integration.md` |
| `docs/platform-endpoint-discovery-contract.md` | contract | reconciled against current endpoint producers, consumers, and defaults | `docs/contracts/platform-endpoint-discovery.md` |
| `docs/archive/2026-06/*.md` | historical implementation prose | consolidated here; originals remain at the recovery revision | `docs/architecture/`, `docs/contracts/`, and current code |
| former `designs`, `diagrams`, `qa`, `retros`, `debates`, and `spikes` roots | role aliases | normalized without deleting assets | `design/`, `architecture/diagrams/`, `verification/`, `retrospectives/`, and `audits/` |
| implementation `build.md`, `dev-plan.md`, and `tasks.md` embedded in design packages | historical delivery prose | retained unchanged as protected source material, but removed from current design authority | `docs/archive/assets/design-program/`; GitHub Issues own active work |
| timeline-overhaul `audit.md` embedded in a design package | verification evidence | normalized without content deletion | `docs/audits/2026-06-28-timeline-overhaul.md` |
| `docs/contracts/env-migration-rollback-reconcile.md` | retired compatibility contract | removed with the retired-root importer; no migration, rollback reconciliation, dual-read, marker, or receipt remains | `docs/contracts/extension-cas-seed.md` §1; recovery revision `cb486c70` |

No item in this ledger owns current status, priority, assignee, or Sprint
membership. Protected design, decision, audit, verification, retrospective,
and runtime-rule assets retain their original content in canonical role paths.
