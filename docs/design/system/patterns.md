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

When a surface can't be cleanly swapped, alpha injects into upstream DOM:
`composer-takeover.tsx` (takes over upstream composer anchors, hides
`prompt-input`), `timeline-inject.tsx` (injects rendering + reskin into the
upstream timeline). Lineage = `hybrid`. Injection targets stable upstream anchors
— it does not fork upstream components.

## Reskin (retint only)

CSS-only restyling of upstream DOM with `--a-*` (`settings-reskin.css`,
`timeline-reskin.css`) plus, at most, a small DOM observer
(`settings-back-button.ts`). Use when the surface must stay upstream but look
alpha. A reskin must not grow into a logic fork; when behavior must change,
promote to a seam surface instead.

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
