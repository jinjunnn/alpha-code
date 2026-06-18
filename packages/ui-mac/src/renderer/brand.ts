// alpha-code brand palette — single source of truth.
//
// Sampled from the app icon (orange squircle + cream Greek α):
//   packages/ui-mac/icons/<channel>/icon.png
// Consumed by: theme-alpha.ts (the Alpha theme), logo-alpha.tsx (the α splash).
// Keep these in sync with the icon so theme accent / splash / app icon read as one brand.
export const BRAND = {
  /** Core brand orange (icon gradient mid-tone). */
  orange: "#F87814",
  /** Icon gradient top — lighter, used for highlights / splash gradient start. */
  orangeLight: "#FC9516",
  /** Icon gradient bottom — deeper, used for splash gradient end. */
  orangeDeep: "#F46013",
  /** A touch deeper than `orange` — light-mode accent / pressed states. */
  orangeAccent: "#D85F12",
  /** The α glyph fill / warm foreground that sits on orange. */
  cream: "#FBF4EC",
} as const
