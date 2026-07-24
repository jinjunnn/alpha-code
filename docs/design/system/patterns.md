---
title: composition patterns
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Composition patterns

How alpha surfaces attach to an app whose shell it inherited from opencode.
alpha-code is a fork: `packages/ui-mac` (the Electron app) is alpha-authored and
mounts upstream `@opencode-ai/app`, then replaces or overlays pieces. Every
pattern below preserves the ability to **fall back to upstream**.

## Surface seam (replace an upstream leaf)

Alpha swaps an upstream page through the typed `AppSurfaces` seam
(`home` / `newSession` / `session`), gated by
`packages/ui-mac/src/shared/alpha-surfaces.ts`:

- `SURFACE_RELEASE_STATES` = `auto-fallback` (ship alpha, fall back to upstream
  on crash) or `legacy` (ship upstream; alpha built but off).
- A seam surface is a real alpha component; if it throws, the app renders the
  upstream leaf. Never replace a leaf without a fallback path.

## Takeover / injection (augment an upstream surface in place)

When a surface can't be cleanly swapped, alpha injects into upstream DOM.
Lineage = `hybrid`. Injection targets stable upstream anchors — it does not fork
upstream components. This pattern currently has **zero live instances**: its two
long-lived users, `composer-takeover.tsx` and `timeline-inject.tsx`, were
retired by REQ-125 (C7/C8) when the session page became a seam-owned alpha
surface. Treat it as a documented last resort, not an active convention.

## Reskin (retint only)

CSS-only restyling of upstream DOM with `--a-*`. The one live instance is
`composer-reskin.css` (retints the upstream v2 composer that legacy session mode
still renders). Use when the surface must stay upstream but look alpha. A reskin
must not grow into a logic fork; when behavior must change, promote to a seam
surface instead — `settings-reskin.css`, `dialog-reskin.css`, and
`timeline-reskin.css` were all retired this way (REQ-090, REQ-125).

## Full-page overlay (alpha-new surface)

Net-new surfaces with no upstream equivalent render as a full-page Portal over
the shell: Extension Hub (`extensions/extension-hub.tsx`), Automations
(`automations/automation-panel.tsx`), Artifact Workbench
(`alpha-ui/artifact-workbench/`). These own their own layout and use the token
system directly.

## Recovery / fallback boundary

Alpha surfaces are wrapped so a fatal error degrades instead of white-screening:
`alpha-ui/surface-boundary.tsx` (records, then reloads and falls back to the
upstream leaf per the resolver, #334) and `main/db-safety-boot.ts` (Electron-side
boot recovery / DB safety). Design every alpha surface assuming it may be the
thing that failed — provide an empty state, a loading state, and a degraded path.

## Rollout is a state, not a flag day

A surface moves `legacy → auto-fallback → (eventually) alpha` via
`alpha-surfaces.ts`, not by deleting the upstream path. The upstream surface
stays reachable until the alpha one is proven. This is why `../PAGE-MAP.md` marks
several surfaces `partial`.
