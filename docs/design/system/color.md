---
title: color system (用色宪法)
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Color system — 用色宪法

Cool graphite / porcelain neutral spine + one restrained indigo accent. Values
below mirror [`tokens.css`](../../../packages/ui-mac/src/renderer/alpha-ui/tokens.css),
which is the source of truth (light `:root`, dark `:root[data-color-scheme="dark"]`).
Use the semantic **role**, never a raw hex.

## Neutral spine

| Token | Role | Light (porcelain) | Dark (graphite) |
| --- | --- | --- | --- |
| `--a-bg-canvas` | app background / main content (brightest) | `#ffffff` | `#0a0b0d` |
| `--a-bg-subtle` | recessed areas, sidebars | `#f6f7f9` | `#0e0f11` |
| `--a-bg-muted` | hover fills, inset fields | `#eceef1` | `#16171a` |
| `--a-bg-inset` | pressed / track | `#e3e6ea` | `#1e2024` |
| `--a-surface` | cards, panels, popovers | `#ffffff` | `#121316` |
| `--a-surface-raised` | modals (paired with shadow) | `#ffffff` | `#17181b` |
| `--a-scrim` | modal backdrop | `rgba(15,17,21,.45)` | `rgba(0,0,0,.60)` |

## Borders & text

| Token | Light | Dark | Note |
| --- | --- | --- | --- |
| `--a-border-faint` | `#eef0f3` | `#1b1c20` | hairline dividers |
| `--a-border` | `#e4e6ea` | `#232428` | default control border |
| `--a-border-strong` | `#ced2d9` | `#34363c` | emphasized |
| `--a-text` | `#18181b` | `#fafafa` | primary (~16:1) |
| `--a-text-secondary` | `#52525b` | `#a1a1aa` | labels (~7:1) |
| `--a-text-tertiary` | `#7c7d85` | `#71727a` | placeholder / meta (~4.5:1) |
| `--a-text-disabled` | `#b3b6bd` | `#4f5158` | — |
| `--a-text-on-accent` | `#ffffff` | `#ffffff` | label on accent fill |

## Accent (indigo) — text vs fill are different tokens

- **`--a-accent`** — text/links/icons. Light `#4f46e5`, dark `#818cf8` (lighter,
  tuned for legibility on graphite).
- **`--a-accent-solid`** — **button/fill backgrounds.** Light `#4f46e5`; dark is
  kept **deep** (`#4f46e5`) so white label text clears WCAG 4.5:1 on the fill.
  **Always use `--a-accent-solid` for a filled control, never `--a-accent`** — a
  fill built from the dark text-accent (`#818cf8`) fails contrast (~2.6:1). This
  is the one color caveat that has bitten before.
- **`--a-send` / `--a-send-hover`** — the send button only (`#6366f1`), a softer
  indigo; keeps the global brand accent `#4f46e5` unchanged.
- **`--a-accent-subtle`** (tint fills), **`--a-accent-border`**, **`--a-accent-ring`**
  (focus ring, via `--a-ring-focus`).

## Layered-chrome overlays

Sidebar / list rows use **translucent** overlays so hover/active/selected read
clean over any background:

| Token | Use |
| --- | --- |
| `--a-overlay-hover` | row hover |
| `--a-overlay-active` | row pressed |
| `--a-overlay-selected` | selected = the accent tint (`--a-accent-subtle`) |

## Functional semantics (multi-hue, for legibility only)

`--a-success` `#16a34a`, `--a-warning` `#d97706`, `--a-error` `#dc2626`,
`--a-info` `#2563eb` (dark: `#4ade80` / `#fbbf24` / `#f87171` / `#60a5fa`), each
with a `-subtle` tinted background. Use for status meaning only — never to
decorate or as a second accent.

## Usage rules

- Main reading surface = `--a-bg-canvas`; recess chrome (sidebar) to `--a-bg-subtle`.
- Card/popover = `--a-surface` + a shadow ([`tokens.md`](tokens.md)), not a heavy border.
- Selection = `--a-overlay-selected`; hover = `--a-overlay-hover` — not a solid fill.
- Filled emphasis = `--a-accent-solid` + `--a-text-on-accent`.
- Focus = `--a-ring-focus` (`3px` `--a-accent-ring`), always visible.
