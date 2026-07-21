---
title: design tokens reference
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Design tokens

Every token is a CSS custom property named `--a-<category>-<role>`, defined in
[`tokens.css`](../../../packages/ui-mac/src/renderer/alpha-ui/tokens.css) — the
source of truth. This is the index; colors are detailed in [`color.md`](color.md).

**Rule:** alpha-ui components style with `var(--a-*)` only. A value that isn't a
token yet gets **added to `tokens.css`** (in all of `:root`, the dark block, and
the `prefers-color-scheme` block if color) — never inlined at the call site.

| Category | Tokens | Scale / notes |
| --- | --- | --- |
| **Color** | `--a-bg-*`, `--a-surface*`, `--a-scrim`, `--a-border*`, `--a-text*`, `--a-accent*`, `--a-send*`, `--a-overlay-*`, `--a-success/warning/error/info(-subtle)` | see [`color.md`](color.md); light + dark |
| **Font** | `--a-font-sans`, `--a-font-mono`, `--a-font-display` | system stack; `sans` = `-apple-system`/SF Pro; no webfonts |
| **Text size** | `--a-text-2xs … 3xl` | `10.5, 11.5, 12.5, 13(base), 14(md), 16, 19, 23, 30`px |
| **Leading** | `--a-leading-tight/snug/normal` | `1.2 / 1.4 / 1.55` |
| **Tracking** | `--a-tracking-tight/normal/wide` | `-0.014em / 0 / 0.04em` (wide = overline labels) |
| **Weight** | `--a-weight-normal/medium/semibold/bold` | `400 / 500 / 600 / 680` |
| **Space** | `--a-space-1 … 16` | 4px base: `4,8,12,16,20,24,32,40,48,64`px |
| **Radius** | `--a-radius-xs … 2xl`, `--a-radius-full` | `4,6,8,11,14,18`px, pill |
| **Shadow** | `--a-shadow-xs/sm/md/lg/overlay`, `--a-ring-focus` | soft, low-spread, cool; deeper in dark |
| **Premium** | `--a-edge-light`, `--a-glow-accent`, `--a-grain` | 1px glass top-highlight; ≤4% accent wash; faint fractal grain — depth without color |
| **Motion** | `--a-dur-instant/fast/base/slow`, `--a-ease-out/in-out/spring` | `80/130/190/280`ms; `prefers-reduced-motion` → all 0 |
| **Z-index** | `--a-z-base/sticky/dropdown/overlay/modal/toast` | `0/100/400/800/900/1000` |

## Theming

Dark is keyed off `document.documentElement.dataset.colorScheme`
(`data-color-scheme`), set by `@opencode-ai/ui`'s theme context — so alpha-ui
follows the app's light/dark toggle. `prefers-color-scheme` applies only when the
app hasn't pinned a scheme. Do not add a parallel dark mechanism.
