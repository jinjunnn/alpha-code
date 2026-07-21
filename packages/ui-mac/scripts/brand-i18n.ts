import path from "node:path"
import type { Plugin } from "vite"
import { COMPOSER_PLACEHOLDER, COMPOSER_PLACEHOLDER_UPSTREAM_LITERAL } from "../src/shared/composer-copy"

// Build-time brand substitution for opencode's shared UI strings.
//
// The app i18n dictionaries live in upstream @opencode-ai/app (packages/app/src/i18n/*.ts).
// Per the only-add discipline (.claude/rules/DECISIONS.md ADR-005/007) we must NOT edit them
// on disk — that would conflict on every upstream sync. Instead we rewrite the string literals
// during the renderer bundle: the git-tracked source stays byte-identical to upstream (so
// `git merge dev` never conflicts), while the shipped UI reads "alpha-code". This is the
// "patch layer" for workspace source — bun's patches/ only patch installed npm deps, not
// workspace packages.
//
// CURATED ON PURPOSE: only the app's SELF-references are rebranded. Names of real external
// things stay verbatim so the UI stays factually correct —
//   • "OpenCode Zen" (the hosted model gateway)        • the `opencode.json` config filename
//   • `opencode.ai/zen` (a real URL)                    • the `opencode` CLI binary name
//   • WSL strings (Windows-only; Mac app)
// EXCEPTION (crash screen, C28): the ErrorBoundary fallback (app/src/pages/error.tsx) previously
// told users to "report this error to the OpenCode team … on Discord" and its feedback button
// linked to opencode.ai — user-facing product chrome that leaks upstream identity and routes users
// to opencode's channels. That IS rebranded below (prefix text + discord wording + href + icon).

// Per-locale [from, to] pairs. `from` must be an exact substring of the upstream source.
// Keyed by the locale dict path so we only ever touch the intended file.
const REPLACEMENTS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  // In-session composer placeholder is a HARDCODED literal (not i18n). The 849c2598 frontend pin
  // moved it out of prompt-input.tsx into prompt-input/placeholder.ts:promptDesignPlaceholder().
  // Rewrite it to the SAME text the alpha home composer uses — ONE constant serves both surfaces
  // (src/shared/composer-copy.ts, REQ-038 目标⑥). Zero disk edit (ADR-005/007).
  "app/src/components/prompt-input/placeholder.ts": [
    [COMPOSER_PLACEHOLDER_UPSTREAM_LITERAL, JSON.stringify(COMPOSER_PLACEHOLDER)],
  ],
  // Crash screen (C28): rewrite the OpenCode-branded feedback link + Discord icon in the
  // ErrorBoundary fallback JSX. The visible "report to … team" / "on Discord" TEXT is i18n (below);
  // the href + icon are hardcoded JSX, rewritten here. Feedback routes to alpha's web root until a
  // dedicated feedback page exists.
  "app/src/pages/error.tsx": [
    ['platform.openLink("https://opencode.ai/desktop-feedback")', 'platform.openLink("https://alphacodeone.com")'],
    ['<Icon name="discord" class="text-text-interactive-base" />', ""],
  ],
  "app/src/i18n/en.ts": [
    ["OpenCode Desktop", "alpha-code"],
    ["Change the display language for OpenCode", "Change the display language for alpha-code"],
    ["Customise how OpenCode looks on your device", "Customise how alpha-code looks on your device"],
    [
      "Choose whether OpenCode follows the system, light, or dark theme",
      "Choose whether alpha-code follows the system, light, or dark theme",
    ],
    ["Customise how OpenCode is themed.", "Customise how alpha-code is themed."],
    ["Automatically check for updates when OpenCode launches", "Automatically check for updates when alpha-code launches"],
    ["You're running the latest version of OpenCode.", "You're running the latest version of alpha-code."],
    [
      "A new version of OpenCode ({{version}}) is now available to install.",
      "A new version of alpha-code ({{version}}) is now available to install.",
    ],
    [
      "OpenCode includes free models so you can start immediately.",
      "alpha-code includes free models so you can start immediately.",
    ],
    // Crash screen (C28)
    ["Please report this error to the OpenCode team", "Please report this error to the alpha-code team"],
    ['"on Discord"', '"on our feedback page"'],
  ],
  "app/src/i18n/zh.ts": [
    ["OpenCode Desktop", "alpha-code"],
    ["更改 OpenCode 的显示语言", "更改 alpha-code 的显示语言"],
    ["自定义 OpenCode 在你的设备上的外观", "自定义 alpha-code 在你的设备上的外观"],
    ["选择 OpenCode 跟随系统、浅色或深色主题", "选择 alpha-code 跟随系统、浅色或深色主题"],
    ["自定义 OpenCode 的主题。", "自定义 alpha-code 的主题。"],
    ["在 OpenCode 启动时自动检查更新", "在 alpha-code 启动时自动检查更新"],
    ["你正在使用最新版本的 OpenCode。", "你正在使用最新版本的 alpha-code。"],
    ["OpenCode 有新版本 ({{version}}) 可安装。", "alpha-code 有新版本 ({{version}}) 可安装。"],
    ["OpenCode 提供免费模型，你可以立即开始使用。", "alpha-code 提供免费模型，你可以立即开始使用。"],
    // Crash screen (C28)
    ["请将此错误报告给 OpenCode 团队", "请将此错误报告给 alpha-code 团队"],
    ["在 Discord 上", "在反馈页"],
    // Sound option fix: upstream zh machine-transliterated "staplebops" to the garbled "斯泰普博普斯"
    // (sound.option.staplebops01..07). One substring swap cleans all 7 (the " 01".."07" suffix stays);
    // "嗒啵" matches the 哔啵 (bipbop) style. Upstream source untouched (ADR-005/007).
    ["斯泰普博普斯", "嗒啵"],
  ],
  "app/src/i18n/zht.ts": [
    // Crash screen (C28)
    ["請將此錯誤回報給 OpenCode 團隊", "請將此錯誤回報給 alpha-code 團隊"],
    ["在 Discord 上", "在反饋頁"],
    // Traditional-zh has the same garbled staplebops transliteration.
    ["斯泰普博普斯", "嗒啵"],
  ],
}

export function brandI18nPlugin(opts: { strict?: boolean } = {}): Plugin {
  return {
    name: "alpha:brand-i18n",
    enforce: "pre",
    transform(code, id) {
      const norm = id.split(path.sep).join("/")
      const key = Object.keys(REPLACEMENTS).find((k) => norm.includes(k))
      if (!key) return null
      let out = code
      const missing: string[] = []
      for (const [from, to] of REPLACEMENTS[key]) {
        if (!out.includes(from)) {
          missing.push(from)
          continue
        }
        out = out.split(from).join(to)
      }
      if (missing.length) {
        // Drift signal: upstream reworded a string we rebrand. Surface it so the map gets
        // updated; a warning (not an error) keeps the build unblocked by default.
        const msg =
          `[alpha:brand-i18n] ${missing.length} brand string(s) not found in upstream ${key} ` +
          `(upstream reworded them?):\n  - ${missing.join("\n  - ")}`
        if (opts.strict) this.error(msg)
        else this.warn(msg)
      }
      return out === code ? null : { code: out, map: null }
    },
  }
}
