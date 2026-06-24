import type { DesktopTheme } from "@opencode-ai/ui/theme/types"
import { BRAND } from "./brand"

// The alpha-code brand theme. 2026-06-23 rebrand: a monochrome system (neutral
// drives the whole grayscale of backgrounds/surfaces/borders) with ONE restrained
// indigo accent for primary actions / selection / links. Functional semantics
// (success/warning/error/info) and code syntax stay multi-hue for legibility —
// "monochrome chrome + one brand accent", not "no color anywhere".
//
// Registered at runtime via theme.registerTheme() (see renderer/index.tsx);
// opencode source is never touched. Appears in the theme picker as "Alpha".
export const ALPHA_THEME_ID = "alpha"

export const ALPHA_THEME: DesktopTheme = {
  $schema: "https://opencode.ai/desktop-theme.json",
  name: "Alpha",
  id: ALPHA_THEME_ID,
  light: {
    palette: {
      neutral: "#ffffff",
      ink: "#161616",
      primary: BRAND.accent,
      accent: BRAND.accentPressed,
      success: "#16a34a",
      warning: "#b45309",
      error: "#dc2626",
      info: "#0e7490",
      diffAdd: "#16a34a",
      diffDelete: "#e5484d",
    },
    overrides: {
      "text-weak": "#6b7280",
      "syntax-comment": "#9ca3af",
      "syntax-keyword": BRAND.accent,
      "syntax-string": "#16a34a",
      "syntax-primitive": "#b45309",
      "syntax-variable": "#be123c",
      "syntax-property": "#0e7490",
      "syntax-type": "#7c3aed",
      "syntax-constant": BRAND.accent,
      "syntax-operator": "#6b7280",
      "syntax-punctuation": "#161616",
      "syntax-object": "#be123c",
      "markdown-heading": "#161616",
      "markdown-text": "#161616",
      "markdown-link": BRAND.accent,
      "markdown-link-text": "#0e7490",
      "markdown-code": "#b45309",
      "markdown-block-quote": "#6b7280",
      "markdown-emph": "#161616",
      "markdown-strong": "#161616",
      "markdown-horizontal-rule": "#d1d5db",
      "markdown-list-item": BRAND.accent,
      "markdown-list-enumeration": "#6b7280",
      "markdown-image": BRAND.accent,
      "markdown-image-text": "#0e7490",
      "markdown-code-block": "#161616",
    },
  },
  dark: {
    palette: {
      neutral: "#0a0a0a",
      ink: "#ededed",
      primary: BRAND.accentDark,
      accent: BRAND.accentDarkHi,
      success: "#4ade80",
      warning: "#fbbf24",
      error: "#f87171",
      info: "#38bdf8",
      diffAdd: "#4ade80",
      diffDelete: "#f87171",
    },
    overrides: {
      "text-weak": "#8a8a8a",
      "syntax-comment": "#6b7280",
      "syntax-keyword": BRAND.accentDark,
      "syntax-string": "#4ade80",
      "syntax-primitive": "#fbbf24",
      "syntax-variable": "#f87171",
      "syntax-property": "#38bdf8",
      "syntax-type": "#c4b5fd",
      "syntax-constant": BRAND.accentDark,
      "syntax-operator": "#9ca3af",
      "syntax-punctuation": "#ededed",
      "syntax-object": "#f87171",
      "markdown-heading": "#fafafa",
      "markdown-text": "#ededed",
      "markdown-link": BRAND.accentDark,
      "markdown-link-text": "#38bdf8",
      "markdown-code": "#fbbf24",
      "markdown-block-quote": "#9ca3af",
      "markdown-emph": "#ededed",
      "markdown-strong": "#fafafa",
      "markdown-horizontal-rule": "#3f3f46",
      "markdown-list-item": BRAND.accentDark,
      "markdown-list-enumeration": "#9ca3af",
      "markdown-image": BRAND.accentDark,
      "markdown-image-text": "#38bdf8",
      "markdown-code-block": "#ededed",
    },
  },
}
