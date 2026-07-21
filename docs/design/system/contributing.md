---
title: contributing to design (process)
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Contributing to design

Two rules are mandatory. They exist so design is always an informed **edit** of a
known surface, produced with the right tool — never a blind, from-scratch redraw.

## R1 — Start from the entry point; optimize the incumbent

Before you design or change any surface, you MUST load its context first:

1. **[`../PAGE-MAP.md`](../PAGE-MAP.md)** — find the surface, its alpha/opencode
   status, its **code entry file**, and its current design.
2. **The current design** — `../current/<page>/design.html` (the living draft)
   and the surface's dated history if you need the rationale.
3. **The design system** — [`principles.md`](principles.md),
   [`color.md`](color.md), [`tokens.md`](tokens.md), [`components.md`](components.md),
   [`patterns.md`](patterns.md).
4. **The real code** — open the entry file(s) so the design targets what actually
   ships.

Then design the **existing** surface forward. Do not invent a parallel
information architecture, and do not restyle outside the token system. Every new
draft must open with a **"关系 / relationship to previous draft"** block stating
what it inherits from the last approved draft and the current implementation, and
what it changes. A draft with no such block is incomplete.

## R2 — Produce it with the `frontend-design` skill

All interface **production** — new or updated design mocks/HTML, and the
component gallery — goes through Claude Code's **`frontend-design`** skill. Do not
hand-roll interface HTML outside it. (Authoring these markdown docs from existing
code is documentation, not the skill's job; producing a *rendered interface* is.)

## Token & accessibility discipline

- Style with `var(--a-*)` only; add new tokens in `tokens.css`
  ([`tokens.md`](tokens.md)) — never hardcode a value.
- Never edit upstream `--v2-*`/opencode tokens or fork upstream DOM; build as a
  seam/overlay/reskin ([`patterns.md`](patterns.md)).
- Light + dark, WCAG contrast (body ≥4.5:1, secondary ≥3:1), visible focus
  (`--a-ring-focus`), `prefers-reduced-motion` honored.
- No developer jargon in UI copy or inside a mock frame.

## Where the work lands

- Iterate in **`../current/<page>/design.html`** (edit in place).
- On approval / ship: cut a dated snapshot `../2026-…-<name>/` to freeze the
  approved state, and update the surface's row in `../PAGE-MAP.md`.
- Keep status/owner/priority in GitHub Issues, not in these files.

The two-layer model (current vs frozen history) is in [`../README.md`](../README.md).
