---
title: alpha-code design system
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Design system

The canonical, living home for alpha-code's own design language ("full-takeover
rebuild", cool graphite / porcelain). Read this **before** designing or changing
any surface — that is a hard rule, see [`contributing.md`](contributing.md).

## Source of truth

Design **intent** lives in these docs. The **implemented** values are code:

- **Tokens** → [`packages/ui-mac/src/renderer/alpha-ui/tokens.css`](../../../packages/ui-mac/src/renderer/alpha-ui/tokens.css)
  (`--a-*`). This file is authoritative for every value; the docs distill and
  explain it. When a doc and `tokens.css` disagree, `tokens.css` wins — fix the doc.
- **Components** → `packages/ui-mac/src/renderer/alpha-ui/*.css` + `*.tsx`.
- **Live styleguide** → [`gallery.html`](gallery.html) — every token and component
  rendered in light + dark, generated from the sources above. Open it in a browser.

## Contents

| Doc | What it governs |
| --- | --- |
| [`principles.md`](principles.md) | 设计宪法 — the register and the non-negotiables |
| [`color.md`](color.md) | 用色宪法 — neutral spine, accent, semantics, usage rules |
| [`tokens.md`](tokens.md) | Every `--a-*` token category and scale |
| [`components.md`](components.md) | Component library catalog (source + role + states) |
| [`patterns.md`](patterns.md) | Composite patterns — seam/takeover, overlay, recovery, reskin |
| [`contributing.md`](contributing.md) | How to add/change design — the entry-point rule + frontend-design skill |
| [`gallery.html`](gallery.html) | Rendered styleguide (light + dark) |

The **surface inventory** (which page is alpha vs opencode, and its current
design) is [`../PAGE-MAP.md`](../PAGE-MAP.md). The **two-layer** design model
(current vs history) is [`../README.md`](../README.md).
