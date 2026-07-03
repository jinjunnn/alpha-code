// B6(=G1):ext 装载路径解析单测。契约:packaged 走 resourcesPath/alpha-ext,dev 走仓内 dist;
// 逃生开关短路;缺文件必须给出 reason(调用方 loud warn,不许静默丢工具)。

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveExtPluginPath } from "./alpha-ext-plugin"

const base = {
  resourcesPath: "/App.app/Contents/Resources",
  moduleDir: "/repo/packages/ui-mac/out/main",
  disabled: false,
}

describe("resolveExtPluginPath", () => {
  test("packaged → <resources>/alpha-ext/plugin.js", () => {
    const r = resolveExtPluginPath({ ...base, packaged: true, exists: () => true })
    expect(r.path).toBe(join("/App.app/Contents/Resources", "alpha-ext", "plugin.js"))
  })

  test("dev → 仓内 packages/ext/dist/plugin.js(out/main 相对三跳)", () => {
    const r = resolveExtPluginPath({ ...base, packaged: false, exists: () => true })
    expect(r.path).toBe(join("/repo/packages/ext/dist/plugin.js"))
  })

  test("ALPHA_EXT_DISABLE=1 → 不装载,带原因", () => {
    const r = resolveExtPluginPath({ ...base, packaged: true, disabled: true, exists: () => true })
    expect(r.path).toBeUndefined()
    expect(r.reason).toContain("ALPHA_EXT_DISABLE")
  })

  test("bundle 缺失 → 无 path 且 reason 含具体路径(anti-B11,调用方必须 loud warn)", () => {
    const r = resolveExtPluginPath({ ...base, packaged: true, exists: () => false })
    expect(r.path).toBeUndefined()
    expect(r.reason).toContain("alpha-ext")
  })
})
