// `#1424` —— `webfetch` 注册副本的普查闸。
//
// 为什么存在:`webfetch` 与 `websearch` 一样有**两份**已挂载的注册
// (`packages/opencode/src/tool/webfetch.ts` 与 `packages/core/src/tool/webfetch.ts`),
// 而 `websearch` 有 `./websearch-copies.test.ts` 钉着集合、`webfetch` **一份检查都没有**。
// 后果很具体:`#1414` 的选路点接了其中一份就以为接完了,**不会有任何东西变红**。
//
// 为什么是**复制**而不是抽一个通用框架(窄票不升级成框架,本仓明令):两个工具的被守面不同。
// `websearch` 还有主权闸(`ALPHA_LOCAL_WEBSEARCH_DENY`)与**固定端点**(Exa/Parallel),所以那份文件
// 有「闸是出网出口第一句」的位置锁和「谁引用了端点」的第二张网;`webfetch` 的 URL 是模型在调用那一刻
// 给的,既没有主权闸也没有端点清单可抄。把两者合进一个参数化框架 = 用最松的那一方定义两者的语义。
//
// ── 它守什么 ────────────────────────────────────────────────────────────────────────
// **「`packages/*/src` 里注册为 `webfetch` 的源文件」这个集合变了就红。** 两个方向都红:
// 多一份(上游 sync 带进新叶子 / 有人手写第三份)⇒ 集合变大;少一份或某张网烂掉 ⇒ 集合变小。
// 逼人分类,而不是让第三份静默上线。
//
// ── 它守不住什么(照 ADR-035 R4 的原话,不重新发明)─────────────────────────────────
//   · **算出来的注册名 + 复用已有实现**:`const id = ["web","fetch"].join("")` 之后 `Tool.define(id, …)`
//     —— 三张网都看不见。`websearch` 那边靠「闸下沉到共同出网出口」收口;`webfetch` 没有那个出口
//     (URL 由模型给),所以这一支今天**没有**兜底,不要据本闸声称按类闭合。
//   · **本网结构上看不见另外两条注册路径**:插件(`Plugin.Service` → `tool/registry.ts:221,229` 的
//     `custom.push`)与 MCP(`MCP.Service` → `session/tools.ts:480`)都不产生 `packages/*/src` 下的
//     源文件。**⇒ 本闸绿 ≠ 只有两个入口。** 「模型手里有哪些工具」的单一权威是
//     `packages/opencode/src/session/tools.ts`(`:162` 取 registry+plugin,`:480` 取 MCP),
//     不是任何一个 registry;实读的四条路径表在
//     `docs/architecture/2026-09-23-native-tool-gate-inventory.md` §1.1,决策面在 `ADR-035`。
//   · **「两份都接上了选路」**:本闸只数份数,不判每一份有没有被 `#1414` 的选路点消费。
//
// ── 一个容易踩的实读事实 ────────────────────────────────────────────────────────────
// v1 那份在 `tool/registry.ts` 的 builtin 表里键名是 **`fetch`**(`fetch: Tool.init(webfetch)`),
// 工具 id 才是 `webfetch`(来自 `Tool.define("webfetch", …)`)。按 `webfetch:` 去 grep 注册表会零命中。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".git", "gen", "generated"])

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      found.push(join(dir, entry.name))
    }
  }
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue
    const src = join(REPO_ROOT, "packages", pkg.name, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    walk(src)
  }
  return found
}

const FILES = sourceFiles().map((path) => ({
  path: relative(REPO_ROOT, path).split(sep).join("/"),
  body: readFileSync(path, "utf8"),
}))

/**
 * 「注册了一个叫 `<tool>` 的工具」的三种现行写法。取 `<tool>` 作参数**只为了让谓词自检能拿一根
 * 不存在的负针驱动同一套网**(不是给别的工具复用的框架:本文件只普查 `webfetch`)。
 *
 * 网 ①(v1 `Tool.define`)刻意写成 `Tool\.define[^(\n]*\(` 而不是 `Tool\.define\(` ——
 * 仓里真实存在**带类型参数**的形态(`read` / `todowrite` / `question` 是 `Tool.define<…>(`,
 * 见 `docs/architecture/2026-09-23-native-tool-gate-inventory.md` §1),`Tool\.define\(` 对它失明。
 */
const registrationNets = (tool: string) => [
  new RegExp(`Tool\\.define[^(\\n]*\\(\\s*["'\`]${tool}["'\`]`),
  new RegExp(`export const name\\s*=\\s*["'\`]${tool}["'\`]`),
  new RegExp(`(^|[\\s{,])${tool}\\s*:\\s*(tool|Tool\\.make)\\(`, "m"),
]

const NETS = registrationNets("webfetch")
const registrations = FILES.filter((file) => NETS.some((net) => net.test(file.body)))

describe("webfetch 执行副本普查(#1424)", () => {
  test("全仓注册为 webfetch 的工具恰好是这两份", () => {
    expect(registrations.map((file) => file.path).sort()).toEqual([
      "packages/core/src/tool/webfetch.ts",
      "packages/opencode/src/tool/webfetch.ts",
    ])
  })

  test("谓词自检:三张网各自测得出已知的坏,负针零命中,枚举没有退化", () => {
    // 三张网各喂一条**该命中**的合成样本。少了这一条,一张今天零成员的网(网 ③)可以被改成
    // 恒假而没有任何东西变红 —— 上面那条集合断言只证明今天的两个成员还在。
    const samples = [
      'export const WebFetchTool = Tool.define(\n  "webfetch",',
      'export const WebFetchTool = Tool.define<Ctx>("webfetch", impl)',
      'export const name = "webfetch"',
      "  webfetch: tool({ description: 'x' }),",
      "  webfetch: Tool.make({}),",
    ]
    for (const sample of samples) expect([sample, NETS.some((net) => net.test(sample))]).toEqual([sample, true])
    // 反例:名字只是**被提到**(权限档、风险分级、i18n 文案)不是注册。
    for (const sample of [
      '  const risk = TOOL_RISK["webfetch"]',
      '  permission: "webfetch",',
      '  "tool.webfetch.title": "读取网页",',
    ])
      expect([sample, NETS.some((net) => net.test(sample))]).toEqual([sample, false])
    // 负针:同一套网换一个**不存在**的工具名必须扫出空集 —— 否则网太松,上面的集合断言也不可信。
    const needle = registrationNets("webfetch_needle_that_does_not_exist")
    expect(FILES.filter((file) => needle.some((net) => net.test(file.body))).map((file) => file.path)).toEqual([])
    // 枚举没有退化:`sourceFiles()` 只走到两三个包时,上面那条集合断言**照样绿**,而
    // `packages/ext` 里的第三份副本就隐身了。所以要同时钉住规模与必须被走到的包。
    expect(FILES.length).toBeGreaterThanOrEqual(2400)
    const walked = new Set(FILES.map((file) => file.path.split("/")[1]!))
    for (const pkg of ["core", "opencode", "ext", "ui-mac", "plugin"]) expect([pkg, walked.has(pkg)]).toEqual([pkg, true])
  })
})
