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
mounts upstream `@opencode-ai/app`, then replaces or overlays pieces. The
upstream leaf remains reachable only as a **boot-time escape valve** (env/pin →
`legacy`); there is no runtime fallback — a crashed alpha surface enters Alpha
Recovery, never the upstream leaf.

## Surface seam (replace an upstream leaf)

Alpha swaps an upstream page through the typed `AppSurfaces` seam
(`home` / `newSession` / `session`), whose ids live in
`packages/ui-mac/src/shared/alpha-surfaces.ts`:

- Each route composes **exactly one** surface, resolved from the route manifest
  by `renderer/route-composition.ts`. There is no release state, no env or pin
  override, and no runtime switch: the alpha leaf is the only composition
  (REQ-089 hard cut; the ratchet in `shared/route-authority-ratchet.test.ts`
  keeps the flag machine from growing back).
- A seam surface is a real alpha component; if it throws,
  `surface-boundary.tsx` records the crash once and admits **Alpha Recovery**
  (REQ-090 one-way door) — the failed region never reloads and never swaps to
  the legacy leaf.

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

## Recovery boundary

Alpha surfaces are wrapped so a fatal error degrades instead of white-screening:
`alpha-ui/surface-boundary.tsx` admits the crash once (stable crashID → one
process-local incident) into **Alpha Recovery** — no reload, no legacy swap —
and `main/db-safety-boot.ts` handles Electron-side boot recovery / DB safety.
Design every alpha surface assuming it may be the thing that failed — provide an
empty state, a loading state, and a degraded path.

## Rollout is a sequence of merges, not a flag day

A surface is replaced by landing its alpha leaf as the route's single
composition. There is no release flag and no boot-time escape valve: a fatal
render goes to Alpha Recovery, never to an upstream leaf. Sequencing lives in
Issues, and `../PAGE-MAP.md` marks a surface `partial` while its replacement is
in flight.
