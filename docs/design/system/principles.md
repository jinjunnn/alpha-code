---
title: design principles (设计宪法)
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Design principles — 设计宪法

Distilled from `tokens.css`, the cool-graphite visual system, and the shipped
alpha-ui surfaces. These are the non-negotiables; a design that breaks one is
wrong until the principle is explicitly changed here first.

## Register

Quiet, restrained, low-saturation. The **Linear / Vercel / Raycast** register:
premium through calm and precision, never through decoration. Content is the
loudest thing on screen. If a surface feels busy or "designed", it is off-brand.

## The non-negotiables

1. **Cool graphite / porcelain neutral spine.** Slate-tinted cool neutrals —
   porcelain in light, graphite in dark. Never warm-neutral (zinc) or pure
   grey. Values are in [`color.md`](color.md) / `tokens.css`.
2. **One restrained indigo accent.** A single accent hue (`--a-accent`) carries
   emphasis, selection, and focus. Do **not** introduce competing accent hues.
   Functional semantics (success/warning/error/info) stay multi-hue **only** for
   legibility, never as decoration.
3. **Light and dark are both first-class.** Every surface is designed and
   contrast-checked in both. Targets: body text ≥ 4.5:1, secondary ≥ 3:1 (WCAG).
   Neither mode is an afterthought recolor of the other.
4. **System font stack.** `-apple-system` / SF Pro (`--a-font-sans`). Native
   reads more premium than a webfont here. **Never import Inter** or bundle fonts.
5. **Tokens are the only styling primitive.** alpha-ui components consume
   **only** `--a-*` variables — zero hardcoded colors, spacing, radii, or
   durations. New value → add a token in `tokens.css` ([`tokens.md`](tokens.md)),
   never inline it.
6. **Zero upstream token edits.** alpha owns `--a-*`. Never edit opencode's
   `--v2-*` / upstream tokens or fork upstream DOM; alpha surfaces are built as
   `--a-*` overlays/takeovers that degrade back to upstream (ADR-005/016
   north-star; see [`patterns.md`](patterns.md)).
7. **No developer jargon in the UI.** No REQ numbers, issue numbers, sprint/
   iteration labels, or "本稿新增" markers inside product copy or mock frames.
   Increment annotations live outside the frame only.
8. **Motion is subtle and honest.** Entrances 130–280ms, `--a-ease-out`; nothing
   bounces without reason. `prefers-reduced-motion` collapses all durations to 0.
9. **Depth without color.** Elevation comes from low-spread cool shadows, a 1px
   glass edge-light, and (at most) a ≤4% accent glow and a faint grain — never
   from saturated fills or heavy borders.
10. **Accessible by construction.** Visible focus ring (`--a-ring-focus`),
    keyboard-reachable controls, hit targets that match the mock, and semantic
    color never the *only* signal.

## Optimize the incumbent, never redraw blind

Every surface already exists (see [`../PAGE-MAP.md`](../PAGE-MAP.md)). Design is
an **edit** to a known surface with a known code entry and a known prior draft —
not a fresh invention. The full rule is in [`contributing.md`](contributing.md).
