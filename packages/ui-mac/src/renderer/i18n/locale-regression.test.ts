import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as en } from "./en"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { setLocale, t } from "."
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import rawCatalog from "../extensions/alpha-catalog.json"
import type { Catalog } from "../extensions/catalog-types"
import { catalogDescription } from "../extensions/ext-presentation"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { RecoverySurface } from "../alpha-ui/RecoverySurface"
import { RECOVERY_ACTION_RESULT_CODES, type RecoveryAction, type RecoveryActionResult } from "../../shared/recovery"

// Fresh C20 scan on 2026-07-21: these shipped surfaces contained user-visible
// literals and are now registered here so a later edit cannot silently undo i18n.
const EXTERNALIZED_SURFACES = [
  "alpha-ui/AlphaHome.tsx",
  "alpha-ui/AlphaOnboarding.tsx",
  "alpha-ui/PermissionDialog.tsx",
  "alpha-ui/RecoverySurface.tsx",
  "alpha-ui/Toast.tsx",
  "alpha-ui/alpha-boundary.tsx",
  "alpha-ui/alpha-composer-model.tsx",
  "alpha-ui/alpha-composer.tsx",
  "alpha-ui/alpha-new-session.tsx",
  "alpha-ui/artifact-html-preview/ArtifactHtmlPreview.tsx",
  "alpha-ui/composer-autocomplete.tsx",
  "alpha-ui/model-picker-add.tsx",
  "alpha-ui/model-picker-core.ts",
  "alpha-ui/session-workspace/alpha-session-workspace.tsx",
  "alpha-ui/session-workspace/session-approval-card.tsx",
  "alpha-ui/session-workspace/session-composer-dock.tsx",
  "alpha-ui/settings.tsx",
  "alpha-ui/surface-boundary.tsx",
  "dev/surface-map-inspector.tsx",
  "index.tsx",
  "sidebar/alpha-sidebar.tsx",
] as const

const localeDictionaries = { ar, br, bs, da, de, en, es, fr, ja, ko, no, pl, ru, uk, zh, zht }

const visibleOpencodeAllowlist = {
  // `opencode` is the real installed CLI executable; renaming this instruction would break the command.
  "desktop.cli.installed.message": "cli-command",
  // This is the real upstream-compatible configuration path written by the shipped app.
  "alpha.ext.confirmNote": "config-path",
} as const

describe("locale regression gate", () => {
  test("English and Simplified Chinese expose exactly the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  test("locale switching and missing keys fall back predictably", () => {
    setLocale("zh")
    expect(t("alpha.home.greetingMorning")).toBe(zh["alpha.home.greetingMorning"])

    setLocale("en")
    expect(t("alpha.home.greetingMorning")).toBe(en["alpha.home.greetingMorning"])

    setLocale("ja")
    expect(t("alpha.home.greetingMorning")).toBe(en["alpha.home.greetingMorning"])
    expect(t("alpha.c20.intentionally-missing" as never)).toBe("alpha.c20.intentionally-missing")

    setLocale("en")
  })

  test("model row labels omit the trailing separator when status is empty", () => {
    (["en", "zh"] as const).forEach((locale) => {
      setLocale(locale)
      const status = String()
      const label = status
        ? t("alpha.model.rowLabel", { model: "GPT-4", provider: "OpenAI", status })
        : t("alpha.model.rowLabelNoStatus", { model: "GPT-4", provider: "OpenAI" })

      expect(label).not.toMatch(/[,，]\s*$/)
    })
    setLocale("en")
  })

  test("freshly registered shipped surfaces keep translation lookups", async () => {
    const renderer = join(import.meta.dir, "..")
    const externalized = await Promise.all(
      EXTERNALIZED_SURFACES.map(async (file) => ({ file, source: await Bun.file(join(renderer, file)).text() })),
    )

    expect(externalized.filter((item) => !item.source.includes("t("))).toEqual([])
  })

  test("locale values contain no self-branding outside real compatibility names", () => {
    const occurrences = Object.entries(localeDictionaries).flatMap(([locale, dictionary]) =>
      Object.entries(dictionary)
        .filter(([, value]) => /opencode/i.test(value))
        .map(([key]) => ({ locale, key })),
    )

    expect(occurrences.filter((item) => !(item.key in visibleOpencodeAllowlist))).toEqual([])
  })

  test("catalog descriptions remove upstream branding at the presentation boundary", () => {
    const occurrences = (rawCatalog as unknown as Catalog).entries
      .map((entry) => ({ id: entry.id, description: catalogDescription(entry) }))
      .filter((entry) => /opencode/i.test(entry.description))

    expect(occurrences).toEqual([])
  })

  test("renderer source contains no uppercase self-reference outside the real bundle name", async () => {
    const renderer = join(import.meta.dir, "..")
    const files = Array.from(new Bun.Glob("**/*.{ts,tsx,css,json}").scanSync(renderer)).filter(
      (file) => file !== "i18n/locale-regression.test.ts",
    )
    const occurrences = (
      await Promise.all(
        files.map(async (file) => ({
          file,
          tokens: Array.from((await Bun.file(join(renderer, file)).text()).matchAll(/OpenCode[A-Za-z]*(?:\.app)?/g)).map(
            (match) => match[0],
          ),
        })),
      )
    ).flatMap((item) => item.tokens.map((token) => ({ file: item.file, token })))

    expect(occurrences).toEqual([
      // Historical verification names the real third-party macOS bundle that is no longer redistributed.
      { file: "extensions/alpha-catalog.json", token: "OpenCodeNotifier.app" },
    ])
  })
})

// The gate above proves the dictionaries agree on keys and that t() resolves a zh value in
// isolation. Neither proves a *rendered* component actually reaches the dictionary — the exact
// blind spot #475 slipped through (self-consistent dict, but the shipped surface could have kept
// a hardcoded literal). This smoke test builds the smallest real render runtime and asserts a zh
// value lands in real DOM. The vite bundle inlines its own i18n instance, pinned to zh by the
// ALPHA_UI_LOCALE preload, so the assertion is independent of the setLocale() calls above.
describe("locale render smoke — dictionary self-consistency is not proof the render used it", () => {
  test(
    "a real alpha component renders a zh dictionary value into the DOM under the zh locale",
    async () => {
      const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-locale-render-"))
      try {
        await build({
          configFile: false,
          logLevel: "silent",
          plugins: [appPlugin.at(-1)!],
          build: {
            emptyOutDir: true,
            outDir: runtimeDirectory,
            lib: {
              entry: join(import.meta.dir, "..", "alpha-ui", "recovery-test-runtime.ts"),
              formats: ["es"],
              fileName: () => "recovery-test-runtime.js",
            },
            rollupOptions: { output: { inlineDynamicImports: true } },
          },
        })

        GlobalRegistrator.register()
        try {
          const runtime = (await import(pathToFileURL(join(runtimeDirectory, "recovery-test-runtime.js")).href)) as {
            createComponent: typeof createComponent
            render: typeof render
            RecoverySurface: typeof RecoverySurface
          }
          const host = document.createElement("div")
          document.body.append(host)
          const dispose = runtime.render(
            () =>
              runtime.createComponent(runtime.RecoverySurface, {
                unavailable: true,
                submit: async (_incident: string, action: RecoveryAction): Promise<RecoveryActionResult> => ({
                  ok: true,
                  code: RECOVERY_ACTION_RESULT_CODES.applied,
                  action,
                  applied: true,
                }),
              }),
            host,
          )
          await Promise.resolve()
          await Promise.resolve()

          // Real component → real DOM: the zh value must be present because the component's t()
          // call resolved it, not because the dictionaries merely agree on keys.
          expect(host.textContent).toContain(zh["alpha.recovery.unavailable"])
          expect(host.querySelector("#alpha-recovery-title")?.textContent).toBe(zh["alpha.recovery.unavailable"])
          dispose()
          document.body.replaceChildren()
        } finally {
          await GlobalRegistrator.unregister()
        }
      } finally {
        rmSync(runtimeDirectory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
