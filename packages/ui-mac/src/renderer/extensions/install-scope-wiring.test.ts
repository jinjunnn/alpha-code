// ADR-030(REQ-098 #372)wiring 合同:六个第一方生产动作(MCP / skill / plugin / agent / cloud /
// bundle)传给 window.api.ext.installCatalog 的 intent 必须 scope=global —— project 受管安装已收回。
// 强制层在 main(planner decode 后 policy guard,ext-install-planner.test.ts 的运行时拒绝用例);
// 本测试锁第一方调用图:renderer 不发注定被拒的 project intent,新增第 8 个调用点或改动既有
// scope 字面量都会在此显形。hook 挂载依赖引擎 client + Solid 运行时,bun test 下不可复现
//(use-extensions-ipc.test.ts 同款约束),故按源文本逐调用点断言。
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const here = import.meta.dir

/** 提取每个 `installCatalog(` 调用的实参文本(括号配平;跳过注释里的提及)。 */
function installCatalogCallArgs(source: string): string[] {
  const out: string[] = []
  const needle = "installCatalog("
  let idx = source.indexOf(needle)
  while (idx !== -1) {
    const lineStart = source.lastIndexOf("\n", idx) + 1
    const linePrefix = source.slice(lineStart, idx).trimStart()
    if (!linePrefix.startsWith("//") && !linePrefix.startsWith("*") && !linePrefix.startsWith("/*")) {
      let depth = 1
      let i = idx + needle.length
      while (i < source.length && depth > 0) {
        if (source[i] === "(") depth++
        else if (source[i] === ")") depth--
        i++
      }
      out.push(source.slice(idx + needle.length, i - 1))
    }
    idx = source.indexOf(needle, idx + needle.length)
  }
  return out
}

const read = (rel: string) => fs.readFileSync(path.join(here, rel), "utf8")

describe("ADR-030 wiring: 第一方 installCatalog 调用全部 scope=global", () => {
  test("use-extensions.ts:五个动作(mcp/skill/plugin/agent/cloud)", () => {
    const calls = installCatalogCallArgs(read("use-extensions.ts"))
    expect(calls).toHaveLength(5) // 新增调用点必须来此登记并保持 global
    for (const args of calls) expect(args).toContain(`scope: { scope: "global" }`)
    for (const args of calls) expect(args).not.toContain(`"project"`)
  })

  test("extension-hub.tsx:package 与 bundle 动作", () => {
    const calls = installCatalogCallArgs(read("extension-hub.tsx"))
    expect(calls).toHaveLength(2)
    for (const args of calls) expect(args).toContain(`scope: { scope: "global" }`)
    for (const args of calls) expect(args).not.toContain(`"project"`)
  })

  test("整个 renderer 树无其它 installCatalog 调用文件(第 8 个入口必须显式登记)", () => {
    const rendererRoot = path.resolve(here, "..")
    const withCalls: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (
          (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
          !e.name.endsWith(".test.ts") &&
          !e.name.endsWith(".test.tsx") &&
          installCatalogCallArgs(fs.readFileSync(abs, "utf8")).length > 0
        )
          withCalls.push(path.relative(rendererRoot, abs))
      }
    }
    walk(rendererRoot)
    expect(withCalls.sort()).toEqual(["extensions/extension-hub.tsx", "extensions/use-extensions.ts"])
  })
})
