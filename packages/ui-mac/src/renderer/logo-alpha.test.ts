// `ac#1479` —— 上游 opencode 标志在打包期被换成 alpha 小狗。
//
// 替换靠 electron.vite.config.ts 的 renderer `resolve.alias` 把 `@opencode-ai/ui/logo` 整个指向
// logo-alpha.tsx。它要成立有三个前提,本文件逐条钉住:
//   ① alias 只吃这一个模块说明符(吃多了会把兄弟模块也换掉,吃少了替换不发生);
//   ② logo-alpha 导出与上游**同名同 viewBox** 的组件 —— 少一个名字,打包时上游的 import 落空;
//      viewBox 变了,上游调用处(w-16 h-20、w-58.5 …)的版面就变了;
//   ③ 组件引用的位图真实存在且是带透明通道的方图。
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { UPSTREAM_LOGO_ALIAS } from "../../scripts/upstream-logo-alias"

const HERE = import.meta.dir
const ALPHA_LOGO = path.join(HERE, "logo-alpha.tsx")
const UPSTREAM_LOGO = path.resolve(HERE, "../../../ui/src/components/logo.tsx")
const CONFIG = path.resolve(HERE, "../../electron.vite.config.ts")
const BRAND_MARK = path.join(HERE, "brand", "brand-mark.png")

/** `export const Name` → 紧随其后的第一个 viewBox。 */
function viewBoxes(source: string) {
  const out = new Map<string, string>()
  const re = /export const (\w+)[\s\S]*?viewBox="([^"]+)"/g
  for (const m of source.matchAll(re)) out.set(m[1]!, m[2]!)
  return out
}

describe("上游标志模块在打包期换成 alpha 小狗(ac#1479)", () => {
  test("alias 精确匹配 @opencode-ai/ui/logo,不吃兄弟模块", () => {
    expect(UPSTREAM_LOGO_ALIAS.find.test("@opencode-ai/ui/logo")).toBe(true)
    expect(UPSTREAM_LOGO_ALIAS.find.test("@opencode-ai/ui/logo-v2")).toBe(false)
    expect(UPSTREAM_LOGO_ALIAS.find.test("@opencode-ai/ui/logos")).toBe(false)
    expect(UPSTREAM_LOGO_ALIAS.find.test("x/@opencode-ai/ui/logo")).toBe(false)
    expect(path.resolve(UPSTREAM_LOGO_ALIAS.replacement)).toBe(ALPHA_LOGO)
  })

  test("renderer 构建配置真的挂了这条 alias", () => {
    const config = fs.readFileSync(CONFIG, "utf8")
    const renderer = config.slice(config.indexOf("renderer: {"))
    expect(renderer).toContain("resolve: { alias: [UPSTREAM_LOGO_ALIAS] }")
  })

  test("logo-alpha 导出与上游同名、同 viewBox 的组件", () => {
    const upstream = viewBoxes(fs.readFileSync(UPSTREAM_LOGO, "utf8"))
    const alpha = viewBoxes(fs.readFileSync(ALPHA_LOGO, "utf8"))
    expect(upstream.size).toBeGreaterThan(0)
    expect([...alpha.keys()].sort()).toEqual([...upstream.keys()].sort())
    for (const [name, box] of upstream) expect(alpha.get(name)).toBe(box)
  })

  test("小狗位图存在,是带透明通道的 256×256 PNG", () => {
    const png = fs.readFileSync(BRAND_MARK)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(256)
    expect(png.readUInt32BE(20)).toBe(256)
    expect(png[25]).toBe(6) // IHDR colour type 6 = RGBA
  })
})
