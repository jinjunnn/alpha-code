// alpha-code brand palette — single source of truth.
//
// 2026-06-23 rebrand: pivoted from the orange squircle to a black/white mark
// (the `<A>` code-bracket icon). The product now reads as a monochrome system
// with ONE restrained accent (indigo) for primary actions / selection / links —
// see ADR-008/ADR-007 (in-app re-skin) and theme-alpha.ts.
//
// Consumed by: theme-alpha.ts (the Alpha theme), logo-alpha.tsx (the in-app mark).
// Keep these in sync with the app icon so theme accent / mark / icon read as one brand.
export const BRAND = {
  /** The single restrained accent — primary buttons, selection, links (light mode). */
  accent: "#4F46E5",
  /** Pressed / hover-darker accent (light mode). */
  accentPressed: "#4338CA",
  /** Accent on dark surfaces — lifted for contrast on near-black. */
  accentDark: "#818CF8",
  /** Brighter accent for emphasis on dark surfaces. */
  accentDarkHi: "#A5B4FC",

  /** Near-black foreground / icon fill (light mode ink). */
  ink: "#1a1a1a",
  /** Near-white foreground (dark mode ink). */
  paper: "#fafafa",
} as const
