---
title: component library
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Component library

alpha's own components live in `packages/ui-mac/src/renderer/alpha-ui/` and
consume only `--a-*` tokens. This is the catalog; the **rendered** states in
light + dark are in [`gallery.html`](gallery.html), and the CSS/TSX listed are
the authority for exact behavior.

## Primitives

| Component | Source (`alpha-ui/`) | Role | States |
| --- | --- | --- | --- |
| **Button** | `Button.tsx` + `button.css` | actions | default · hover · active · disabled · focus-ring; variants: neutral, accent-fill (`--a-accent-solid`), send (`--a-send`) |
| **Input** | `Input.tsx` + `input.css` | text entry | default · hover · focus-within (`--a-ring-focus`) · disabled · sm size · icon slot (no error/validation state yet) |
| **Dialog** | `Dialog.tsx` + `dialog.css` | modal | `--a-surface-raised` + `--a-scrim` + `--a-shadow-overlay`, `--a-z-modal` |
| **Toast** | `Toast.tsx` + `toast.css` | transient notice | kinds: `info` / `success` / `error` (**no `warning`** — that's Banner-only); `ToastViewport`, `--a-z-toast` |
| **Tooltip** | `Tooltip.tsx` + `tooltip.css` | hover hint | positioned popover, four placements |
| **Banner** | `Banner.tsx` + `banner.css` | inline persistent notice | `info` / `success` / `warning` / `error`, with inline actions |
| **Base** | `base.css` | element resets / shared primitives for alpha-ui | — |

> Verify exact variants/states against the component CSS and `gallery.html`
> before relying on them — the table names the axes, the code is authoritative.

## Composition surfaces (page-level, not primitives)

`alpha-composer.tsx` + `alpha-composer.css` / `composer-shell.css` (the input
surface), `AlphaHome.tsx` + `home.css`, `AlphaOnboarding.tsx` + `onboarding.css`.
These compose the primitives above; see [`../PAGE-MAP.md`](../PAGE-MAP.md) for the
surface each belongs to.

## Reskin layers (partial surfaces — CSS over upstream DOM)

`composer-reskin.css` (the sole live reskin layer) re-skins **upstream opencode**
DOM with `--a-*` values without forking it. It is not a standalone component — it
retints an inherited surface. See the reskin pattern in
[`patterns.md`](patterns.md). Do not grow a reskin into a fork; if a surface
needs to become truly alpha, build it as an alpha surface behind the seam —
`settings-reskin.css`, `dialog-reskin.css`, and `timeline-reskin.css` were all
retired this way (REQ-090, REQ-125).

## Adding a component

1. New file under `alpha-ui/`, styled with `--a-*` only (add tokens in
   [`tokens.md`](tokens.md)/`tokens.css` first if needed).
2. Light + dark, visible focus, `prefers-reduced-motion` respected.
3. Add a row here and a swatch (all states) to `gallery.html`.
