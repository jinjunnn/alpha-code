import path from "node:path"
import type { Plugin } from "vite"

// Build-time source patches for upstream opencode files we cannot edit on disk (ADR-005/007).
//
// Same discipline as brand-i18n.ts: the git-tracked source stays byte-identical to upstream (so
// `merge dev` never conflicts), while the shipped renderer bundle carries the alpha tweak. Each
// entry is an exact-substring replace keyed by the source path. A miss warns (drift signal) but
// does not fail the build by default — update the patch when upstream reworks the line.
//
// Use this ONLY for behavior that genuinely cannot be reached through an additive seam (CSS,
// settings, Portal). Inline `style={{ width: ... }}` computed in JS is exactly such a case.

const PATCHES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  // Narrow the review / 审查 right panel. opencode clamps the CHAT panel's max width to 45% of the
  // window (packages/app/src/pages/session.tsx ResizeHandle), so the review panel (flex-1, fills
  // the remainder) can never be dragged narrower than ~55% of the window — too wide. Raising the
  // chat max lets the review panel go down to ~30% of the window.
  "app/src/pages/session.tsx": [
    ["window.innerWidth * 0.45", "window.innerWidth * 0.7"],
    // REQ-075: with the review panel open the session column's width is a PERSISTED fixed px
    // (layout.session.width, only updated by dragging the divider) and upstream never re-clamps it
    // on window resize; the column is shrink-0 inside an overflow-hidden ancestor, so shrinking the
    // window clips the composer at the window edge. Our DEFAULT_SESSION_WIDTH patch below (0.64×
    // boot-time innerWidth) amplifies this on big screens. Clamp the column so it can never exceed
    // its flex row; the side panel is min-w-0 (+flex-1 when open) and absorbs the difference.
    ["width: sessionPanelWidth(),", 'width: sessionPanelWidth(), "max-width": "100%",'],
  ],

  // …and make the DEFAULT narrower too. The chat panel defaults to a fixed 600px, so on wide
  // screens the review panel (the remainder) defaults huge. Default the chat to ~64% of the
  // window instead, so the review panel opens at ~36% (still user-resizable + persisted).
  "app/src/context/layout.tsx": [
    [
      "const DEFAULT_SESSION_WIDTH = 600",
      'const DEFAULT_SESSION_WIDTH = typeof window !== "undefined" ? Math.round(window.innerWidth * 0.64) : 600',
    ],
  ],

  // Relocate "Help" from the alpha sidebar footer INTO the settings dialog's own left nav. The
  // sidebar footer now shows Settings only; Help belongs beside the rest of configuration. CSS
  // can't add a working button and there is no stable Portal mount inside this on-demand dialog,
  // so we inject the nav row at the head of the existing footer (app name + version). It reuses
  // `platform.openLink` and `language.t` already in scope, plus the upstream `sidebar.help` key
  // (en "Help" / zh "帮助"). Styled by `.settings-v2-help-trigger` in sidebar.css to match the
  // adjacent TabsV2 triggers. A miss only drops the row (cosmetic), never breaks the build.
  "app/src/components/settings-v2/dialog-settings-v2.tsx": [
    [
      '<div class="settings-v2-nav-footer">',
      '<div class="settings-v2-nav-footer">' +
        '<button type="button" class="settings-v2-help-trigger" ' +
        'onClick={() => platform.openLink("https://opencode.ai/desktop-feedback")}>' +
        '<Icon name="help" /><span>{language.t("sidebar.help")}</span></button>',
    ],
  ],
}

export function patchUpstreamPlugin(opts: { strict?: boolean } = {}): Plugin {
  return {
    name: "alpha:patch-upstream",
    enforce: "pre",
    transform(code, id) {
      const norm = id.split(path.sep).join("/")
      const key = Object.keys(PATCHES).find((k) => norm.includes(k))
      if (!key) return null
      let out = code
      const missing: string[] = []
      for (const [from, to] of PATCHES[key]) {
        if (!out.includes(from)) {
          missing.push(from)
          continue
        }
        out = out.split(from).join(to)
      }
      if (missing.length) {
        const msg =
          `[alpha:patch-upstream] ${missing.length} patch target(s) not found in upstream ${key} ` +
          `(upstream reworked the line?):\n  - ${missing.join("\n  - ")}`
        if (opts.strict) this.error(msg)
        else this.warn(msg)
      }
      return out === code ? null : { code: out, map: null }
    },
  }
}
