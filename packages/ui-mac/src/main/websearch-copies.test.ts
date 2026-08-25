// #223 R4/R5 —— 本地 `websearch` **工具**这一类的主权闸落在传输层;本文件是它的静态半场 + 纵深普查。
//
// ⚠️ R5 事实更正:R4 把下面这两条传输称为 web search 的**共同执行边界** —— 不成立。它们只覆盖
// 「本地 keyless websearch 工具」这一类。用户配置里的通用 Remote MCP
// (`{"mcp":{"exa":{"type":"remote","url":"…"}}}` → `exa_web_search_exa`)两条都不经过,它的钳制点
// 是 `packages/ext` 的 `tool.execute.before` 钩子(证据:
// `packages/opencode/test/tool/alpha-mcp-websearch-gate.test.ts`)。本文件的范围因此**只**是本地
// 工具那一类,别再据它声称 web search 已按类闭合。
//
// 演进史(写在这里免得下一轮又走回头路):
//   R2 收了 legacy `packages/opencode/src/tool/websearch.ts` 的 `execute` 首行。
//   R3 发现打包 sidecar 同时挂载 V2 Location 服务,`packages/core/src/tool/websearch.ts` 是第二份
//      活的同名注册,于是给它也加了首行闸,并加了下面这两张源码普查网当兜底。
//   R4 判普查网**可绕**,给出可执行构造:
//          const id = ["web", "search"].join("")
//          Tool.define(id, /* 调用既有 McpWebSearch.call */)
//      注册名是算出来的(Net A 看不见),传输复用已白名单的 `mcp-websearch.ts`(Net B 也看不见
//      新 URL),新叶子自然不读主权信号 —— 「两个已知实例加闸 + 源码盘点」不是类级规则。
//
// R4 的收口:闸下沉到**共同的执行边界**。本地 keyless web search 要出网只有两条出口,
// 两条都已按 ADR-035 收编为 alpha 全所有权,两条现在都在第一句读同一个信号:
//
//   packages/opencode/src/tool/mcp-websearch.ts  → `call()`      (legacy 引擎唯一的传输)
//   packages/core/src/tool/websearch.ts          → `callMcp()`   (V2 Core 那份副本的传输)
//
// 于是「换个注册名、复用传输」在**执行时**被拒,不需要被任何普查网看见。运行时证据(把 R4 那
// 段构造当变异种真跑一遍)在两个引擎包的 alpha 自有测试里:
//   packages/opencode/test/tool/alpha-websearch-failure.test.ts  · "R4 变异" 一组
//   packages/core/test/alpha-websearch-sovereignty.test.ts       · "R4 变异" 一组
//
// 本文件因此分成两部分:
//   ① 传输闸的位置锁(主判据的静态半场):两条出口的闸都必须排在构造请求之前。
//   ② 普查网(**纵深,不再是主判据**):抓「自带全新 HTTP 出口的副本」这一类 —— 上游 sync 带进
//      来的新工具是现实里唯一见过的形态,它会带字面量端点,两张网看得见。任何一张网变化 = 有人
//      加了新的 web search 执行面,停下来分类,而不是让它静默上线。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  CLOUD_WEBSEARCH_DENY_ENV,
  LOCAL_WEBSEARCH_DENY_ENV,
} from "./cloud-web-search"

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

const FILES = sourceFiles().map((path) => ({ path: relative(REPO_ROOT, path).split(sep).join("/"), body: readFileSync(path, "utf8") }))
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8")

/**
 * 两条出网出口。`egress` = 该文件里发起 HTTP 请求的那个导出函数;闸必须排在它体内、
 * 且在第一次构造请求之前。
 */
const GATED_TRANSPORTS = [
  { path: "packages/opencode/src/tool/mcp-websearch.ts", egress: "export const call = " },
  { path: "packages/core/src/tool/websearch.ts", egress: "export const callMcp = " },
] as const

describe("本地 web search 主权闸落在共同执行边界(#223 R4 主判据 · 静态半场)", () => {
  for (const transport of GATED_TRANSPORTS)
    test(`${transport.path}:闸是出网出口的第一句`, () => {
      const body = read(transport.path)
      const egress = body.indexOf(transport.egress)
      expect(egress, `${transport.path} 找不到出网出口 ${transport.egress}`).toBeGreaterThanOrEqual(0)
      const gate = body.indexOf("if (localWebSearchDenied())", egress)
      const request = body.indexOf("HttpClientRequest.post(", egress)
      expect(gate, `${transport.path} 的出网出口里没有主权闸`).toBeGreaterThan(egress)
      expect(request, `${transport.path} 的出网出口里找不到请求构造`).toBeGreaterThan(egress)
      expect(gate, `${transport.path}: 闸必须早于构造请求(零出网)`).toBeLessThan(request)
    })

  test("出网出口是导出的 —— 「复用传输」才是新副本的正确写法(复用即带闸)", () => {
    for (const transport of GATED_TRANSPORTS) expect(read(transport.path)).toContain(transport.egress)
  })
})

// ── 以下是纵深,不是主判据 ────────────────────────────────────────────────────

/** 「注册了一个叫 websearch 的工具」的三种现行写法(legacy `Tool.define` / V2 模块名约定 / 插件工具表)。 */
const REGISTRATION = [
  /Tool\.define\(\s*["'`]websearch["'`]/,
  /export const name\s*=\s*["'`]websearch["'`]/,
  /(^|[\s{,])websearch\s*:\s*(tool|Tool\.make)\(/m,
]
/** 主权闸必须排在这些「第一次真做事」的调用之前。 */
const FIRST_EFFECT = [/permission\.assert\(/, /ctx\.ask\(/, /callMcp\(/, /callProvider\(/]

const registrations = FILES.filter((file) => REGISTRATION.some((pattern) => pattern.test(file.body)))
const providerCallers = FILES.filter((file) => /mcp\.exa\.ai|search\.parallel\.ai/.test(file.body))
const transportPaths = GATED_TRANSPORTS.map((transport) => transport.path as string)
/**
 * 提到端点但**不出网**的文件。网 ② 抓的是「谁能打到 Exa/Parallel」,一段引用端点的**说明**不是
 * 执行面 —— 但它同样让集合变化,所以按「新增即分类」显式登记,并由下面那条断言证明它确实不出网
 * (零 HTTP / 零 MCP 调用原语)。#223 R5:ext 的闸在注释里引用了那份 exa remote MCP 配置示例。
 */
const DOCUMENTED_MENTIONS = ["packages/ext/src/cloud-websearch-kill.ts"]
const EGRESS_PRIMITIVES = [/HttpClientRequest\./, /\bfetch\s*\(/, /\.callTool\s*\(/, /new\s+Request\s*\(/]

describe("websearch 执行副本普查(#223 R3 · R4 起降为纵深)", () => {
  test("全仓注册为 websearch 的工具恰好是这两份", () => {
    expect(registrations.map((file) => file.path).sort()).toEqual([
      "packages/core/src/tool/websearch.ts",
      "packages/opencode/src/tool/websearch.ts",
    ])
  })

  test("每一份注册的叶子闸(纵深)仍排在任何 permission 交互/出网调用之前", () => {
    expect(registrations.length).toBeGreaterThan(0)
    for (const file of registrations) {
      // 只在 execute 体内比较位置:文件顶部的辅助函数**定义**不是「做事」。
      const body = file.body.indexOf("execute:")
      expect(body, `${file.path} 没有可识别的 execute 入口`).toBeGreaterThanOrEqual(0)
      const gate = file.body.indexOf("if (localWebSearchDenied())", body)
      expect(gate, `${file.path} 的 execute 里缺少主权闸(纵深那一道)`).toBeGreaterThanOrEqual(0)
      for (const pattern of FIRST_EFFECT) {
        const match = pattern.exec(file.body.slice(body))
        if (!match) continue
        expect(gate, `${file.path}: 闸必须早于 ${pattern.source}`).toBeLessThan(body + match.index)
      }
    }
  })

  test("直接引用 Exa/Parallel 端点的文件恰好是两条带闸的传输 + 已登记的纯说明(新增即分类)", () => {
    expect(providerCallers.map((file) => file.path).sort()).toEqual([...transportPaths, ...DOCUMENTED_MENTIONS].sort())
  })

  test("登记为「纯说明」的文件确实不出网(否则它就该按传输分类)", () => {
    for (const path of DOCUMENTED_MENTIONS) {
      const body = read(path)
      for (const pattern of EGRESS_PRIMITIVES)
        expect([path, pattern.source, pattern.test(body)]).toEqual([path, pattern.source, false])
    }
  })

  test("主权信道名在四个包里逐字一致;MCP authority 共享唯一核验源", () => {
    expect(LOCAL_WEBSEARCH_DENY_ENV).toBe("ALPHA_LOCAL_WEBSEARCH_DENY")
    expect(CLOUD_WEBSEARCH_DENY_ENV).toBe("ALPHA_CLOUD_WEBSEARCH_DENY")
    expect(CLOUD_MCP_ARM_ENV).toBe("ALPHA_CLOUD_MCP_ARM")
    // 本地信号的**声明点**已下沉到两条传输(叶子只转出),这条锁跟着下沉。
    for (const transport of GATED_TRANSPORTS)
      expect(read(transport.path)).toContain(`export const LOCAL_WEBSEARCH_DENY_ENV = "${LOCAL_WEBSEARCH_DENY_ENV}"`)
    // legacy 叶子不再自己声明字面量,而是从传输转出 —— 转出丢了就等于两处漂移。
    expect(read("packages/opencode/src/tool/websearch.ts")).toContain(
      "export const LOCAL_WEBSEARCH_DENY_ENV = McpWebSearch.LOCAL_WEBSEARCH_DENY_ENV",
    )
    expect(read("packages/ext/src/cloud-websearch-kill.ts")).toContain(
      `export const CLOUD_WEBSEARCH_DENY_ENV = "${CLOUD_WEBSEARCH_DENY_ENV}"`,
    )
    const extGate = read("packages/ext/src/cloud-websearch-kill.ts")
    expect(extGate).toContain(`export const CLOUD_MCP_ARM_ENV = "${CLOUD_MCP_ARM_ENV}"`)
    // #878 gives the engine snapshot and ext sovereignty gate one verified-definition source.
    // The shared constants live in plugin; ext must explicitly re-export that exact source.
    const authority = read("packages/plugin/src/alpha-cloud-authority.ts")
    for (const [identifier, name] of [
      ["CLOUD_MCP_DEF_ENV", CLOUD_MCP_DEF_ENV],
      ["CLOUD_MCP_SERVER_ENV", CLOUD_MCP_SERVER_ENV],
    ]) {
      expect(authority).toContain(`export const ${identifier} = "${name}"`)
      expect(extGate).toContain(`${identifier},`)
    }
    expect(extGate).toContain('from "@opencode-ai/plugin/alpha-cloud-authority"')
    // 本地判决在 ext 侧也必须逐字一致 —— R5 起 ext 的闸靠它拦第三方 web-search MCP。
    expect(read("packages/ext/src/cloud-websearch-kill.ts")).toContain(
      `export const LOCAL_WEBSEARCH_DENY_ENV = "${LOCAL_WEBSEARCH_DENY_ENV}"`,
    )
    // 两条判决都必须真的过得了 sidecar 白名单,否则闸在打包态恒不置位。
    const allowlist = read("packages/ui-mac/src/main/sidecar-env.ts")
    expect(allowlist).toContain(`"${LOCAL_WEBSEARCH_DENY_ENV}"`)
    expect(allowlist).toContain(`"${CLOUD_WEBSEARCH_DENY_ENV}"`)
    // 三个握手通道不在**固定**白名单里。⚠️ R5 事实更正:这**不等于**「外部 shell 伪造进不来」——
    // 逃生阀 ALPHA_ENV_ALLOWLIST_EXTRA 点名即放行(它们都不是 credential-shaped),那半句 R4 的
    // 断言是错的,真实判据见 sidecar-env.test.ts 与 alpha-config-injection.test.ts 两条。
    for (const name of [CLOUD_MCP_ARM_ENV, CLOUD_MCP_DEF_ENV, CLOUD_MCP_SERVER_ENV])
      expect(allowlist).not.toContain(`"${name}"`)
  })

  test("云侧最终闸是 ext 钩子的第一句(排在契约校验与 ctx.ask 之前)", () => {
    const plugin = read("packages/ext/src/plugin.ts")
    const hook = plugin.indexOf('"tool.execute.before"')
    expect(hook).toBeGreaterThanOrEqual(0)
    // #223 R7:归属实参从模块级默认值改成本实例闭包(`, process.env, mcpOwnership`),故只钉调用点。
    const gate = plugin.indexOf("assertWebSearchToolAllowed(hookInput.tool", hook)
    const contract = plugin.indexOf("validateCloudToolInput(", hook)
    expect(gate).toBeGreaterThan(hook)
    expect(gate).toBeLessThan(contract)
  })

  // #223 R4:ext 装载回执必须是 config 钩子的第一句 —— 它后面那些项目配置分支有 early return,
  // 排在它们之后会让「项目 alpha.jsonc 读不了」顺带把云工具一起关掉。
  // R5:回执从「翻开 enabled:false」改成「把定义装进配置」(`installCloudMcp`),位置要求不变。
  test("ext 装载回执是 config 钩子的第一句", () => {
    const plugin = read("packages/ext/src/plugin.ts")
    const hook = plugin.indexOf("async config(cfg) {")
    expect(hook).toBeGreaterThanOrEqual(0)
    const install = plugin.indexOf("installCloudMcp(cfg)", hook)
    // 只找**语句**形态的 return(行首缩进后紧跟 return),否则注释里的字眼会误判位置。
    const firstReturn = hook + plugin.slice(hook).search(/\n\s*return[\s;]/)
    expect(install).toBeGreaterThan(hook)
    expect(install).toBeLessThan(firstReturn)
  })

  // #223 R5 Major:注入面在 kill-switch 下**不许**把真的云 server 定义写进配置 —— `MCP.connect()`
  // 会无条件把 `enabled:false` 复制成 `enabled:true`(`/mcp/:name/connect` 公开、产品 UI 在调)。
  // #223 R6 Major:但也不能只是「不写」—— 深合并里缺键不会删除 global / alpha.jsonc / 项目里
  // 先前来源的同名定义。唯一允许写进去的是那份中和条目 `WITHHELD_CLOUD_MCP`。
  // 行为证据在 packages/opencode/test/mcp/alpha-cloud-mcp-{revival,multisource}.test.ts;
  // 这里钉住静态形状:kill-switch 下写进 config.mcp 的**只能**是中和条目。
  test("kill-switch 分支写的是中和条目,真定义只经 ARM/DEF 托管", () => {
    const injection = read("packages/ui-mac/src/main/alpha-config-injection.ts")
    // `#1106` 起赋值多了 doomed 三分支(无凭证 ⇒ `{ ...cloud, enabled: false }`),但 kill-switch
    // 臂**必须**仍是中和条目且排在最前(doomed 不得把真 URL 放回 kill-switch 态)。
    const assign = injection.match(
      /config\.mcp = \{\n\s*\.\.\.\(config\.mcp \?\? \{\}\),\n\s*\[CLOUD_MCP_SERVER_NAME\]: killSwitch\n\s*\? \{ \.\.\.WITHHELD_CLOUD_MCP \}\n\s*: doomedConnect\n\s*\? \{ \.\.\.cloud, enabled: false \}\n\s*: cloud,\n\s*\}/,
    )
    expect(assign).not.toBeNull()
    const branch = injection.indexOf("if (killSwitch) {")
    expect(branch).toBeGreaterThanOrEqual(0)
    const elseAt = injection.indexOf("\n      } else {", branch)
    expect(elseAt).toBeGreaterThan(branch)
    const body = injection.slice(branch, elseAt)
    expect(body).toContain(`process.env[CLOUD_MCP_ARM_ENV]`)
    // 这条分支绝不允许再往 config.mcp 里写第二次(真定义只走 ARM/DEF)。
    expect(body).not.toMatch(/config\.mcp\s*=/)
  })

  // #223 R6 Blocker:治理豁免绑定端点身份,所以 DEF 必须在**代付的两条分支**上都置位;
  // 而 ARM 只在 kill-switch 分支置位(ARM/DEF 缺一 ext 什么都不装,这条不变式仍在)。
  test("DEF 在代付两条分支都置位,ARM 只在 kill-switch 分支置位", () => {
    const injection = read("packages/ui-mac/src/main/alpha-config-injection.ts")
    const branch = injection.indexOf("if (killSwitch) {")
    const before = injection.slice(0, branch)
    expect(before).toContain("process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify(cloud)")
    expect(before.lastIndexOf("process.env[CLOUD_MCP_ARM_ENV] = ")).toBe(-1)
  })
})
