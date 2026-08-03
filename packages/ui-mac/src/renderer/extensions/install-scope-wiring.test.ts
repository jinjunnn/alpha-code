// ADR-030(REQ-098 #372)wiring 合同:六个第一方生产动作(MCP / skill / plugin / agent / cloud /
// bundle)传给 window.api.ext.installCatalog 的 intent 必须 scope=global —— project 受管安装已收回。
// 强制层在 main(planner decode 后 policy guard,ext-install-planner.test.ts 的运行时拒绝用例);
// 本测试锁第一方调用图:renderer 不发注定被拒的 project intent,新增第 9 个调用点或改动既有
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
  // `#810`:package 首驱 / 确认屏 / 套件三条原本在 `extension-hub.tsx` 里直连 `extIpc`,
  // 现已收口到 `use-extensions.installCatalogIntent`(引擎重扫接在那一层)。于是本文件的
  // 计数从 5 + 3 变成 6 + 0,而 `scope` 只在**一处**写出来:那正是收口的意义。
  test("use-extensions.ts:五个既有动作(mcp/skill/plugin/agent/cloud)+ package/套件收口点", () => {
    const calls = installCatalogCallArgs(read("use-extensions.ts"))
    expect(calls).toHaveLength(6) // 新增调用点必须来此登记并保持 global
    for (const args of calls) expect(args).toContain(`scope: { scope: "global" }`)
    for (const args of calls) expect(args).not.toContain(`"project"`)
  })

  test("extension-hub.tsx:一个 installCatalog 调用都不许有(`#810` 收口)", () => {
    // 呈现层不得自己出站。这条从「三个调用点都得写对 scope」收紧成「一个都不许有」——
    // 直连回来一个,引擎重扫就对它默认放行,而那是静默的。
    expect(installCatalogCallArgs(read("extension-hub.tsx"))).toHaveLength(0)
  })

  test("整个 renderer 树无其它 installCatalog 调用文件(新入口必须显式登记)", () => {
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
    expect(withCalls.sort()).toEqual(["extensions/use-extensions.ts"])
  })
})
