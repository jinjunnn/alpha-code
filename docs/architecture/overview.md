---
title: Alpha Code architecture overview
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2027-01-13
---

# Architecture overview

## Ownership

`alpha-code` owns the installed desktop application and local trust boundary.
It does not own the cloud gateway, public account/billing surface, or external
Claude Code distribution.

| Surface | Owner |
|---|---|
| Electron desktop shell and product UI | `packages/ui-mac` |
| Alpha extension seams | `packages/ext` |
| Frozen frontend application and component layer | `packages/app`, `packages/ui` |
| Local engine and synchronized upstream packages | governed fork integration |
| Model gateway, cloud jobs, metering | `alpha-platform` |
| Public identity/account/billing UX | `alpha-web` |
| Claude Code plugin packaging | `alpha-code-plugin` |

## Runtime boundary

The Electron main process starts and supervises the local engine, mediates
privileged filesystem/credential operations, and exposes narrow preload/IPC
surfaces to the renderer. The renderer must not gain direct Node, shell, secret,
or unrestricted filesystem access.

Alpha cloud calls cross explicit authenticated contracts owned by
`alpha-platform`; public account and identity flows cross contracts owned by
`alpha-web`. Credentials stay in their owning trust domain and must not be
placed in tracked documentation.

## Sources of truth

- Actual package/runtime behavior: current code, tests, schemas, and workflows.
- Frontend route and non-route composition:
  [`frontend-surfaces.md`](frontend-surfaces.md).
- Upstream ownership and synchronization: [`upstream-integration.md`](upstream-integration.md).
- Durable decisions: `.claude/rules/adrs/` indexed by
  [`.claude/rules/DECISIONS.md`](../../.claude/rules/DECISIONS.md).
- Active delivery: GitHub Issues and Alpha Delivery.
