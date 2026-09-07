import { describe, expect, test } from "bun:test"

import { ALPHA_OPENCODE_VERSION_DEFAULT, patchServerVersion } from "../../scripts/patch-server-version"

// 逐字取自 ac#1248 同步栈(上游 e11dbd020)真构建出的 packages/opencode/dist/node/node.js(2026-09-07)。
// 上游 build-node.ts 从这一版起 define 了 OPENCODE_VERSION,bundler 把 `typeof … : "local"` 折叠成一个字面量。
const BAKED_PREVIEW =
  'var InstallationVersion = "0.0.0-verify/1248-bump-on-sync-202609070253", InstallationChannel = "verify/1248-bump-on-sync", InstallationLocal;'
// 同一形状,但打包任务导出了 OPENCODE_VERSION(publish.yml 那样)⇒ 烤进去的是 app 版本,npm 上同样没有这个 plugin 版本。
const BAKED_APP_VERSION =
  'var InstallationVersion = "0.1.10", InstallationChannel = "prod", InstallationLocal;'
// e11dbd020 之前的形状(本脚本旧版的目标子串)—— 现在的 bundle 里不再出现,脚本也不得再静默接受它。
const LEGACY_FOLDABLE = 'var InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local";'

const V = ALPHA_OPENCODE_VERSION_DEFAULT

describe("embedded server InstallationVersion patch (A4, ac#1248)", () => {
  test("rewrites the baked preview literal to the real npm version and touches nothing else", () => {
    const out = patchServerVersion(`before\n${BAKED_PREVIEW}\nafter`, V)
    expect(out.changed).toBe(true)
    expect(out.baked).toBe("0.0.0-verify/1248-bump-on-sync-202609070253")
    expect(out.text).toBe(
      `before\nvar InstallationVersion = "${V}", InstallationChannel = "verify/1248-bump-on-sync", InstallationLocal;\nafter`,
    )
  })

  test("replaces a packaging-job app version too — any baked literal, not only 0.0.0- previews", () => {
    const out = patchServerVersion(BAKED_APP_VERSION, V)
    expect(out.changed).toBe(true)
    expect(out.baked).toBe("0.1.10")
    expect(out.text).toBe(`var InstallationVersion = "${V}", InstallationChannel = "prod", InstallationLocal;`)
  })

  test("is idempotent once the literal already equals the target", () => {
    const once = patchServerVersion(BAKED_PREVIEW, V).text
    const twice = patchServerVersion(once, V)
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once)
  })

  test("fails closed on the pre-e11dbd020 shape — the old target is not a silent no-op any more", () => {
    expect(() => patchServerVersion(LEGACY_FOLDABLE, V)).toThrow("expected exactly one baked InstallationVersion literal")
  })

  test("fails closed on zero or multiple literals", () => {
    expect(() => patchServerVersion("var InstallationChannel = \"dev\";", V)).toThrow("found 0")
    expect(() => patchServerVersion(`${BAKED_PREVIEW}\n${BAKED_PREVIEW}`, V)).toThrow("found 2")
  })

  test("refuses a target version that cannot be a published release", () => {
    for (const bad of ["local", "0.0.0-dev-202609070253", "", "1.17"]) {
      expect(() => patchServerVersion(BAKED_PREVIEW, bad)).toThrow("must be a published release")
    }
  })
})
