import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  assertWebSearchToolAllowed,
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  CLOUD_WEBSEARCH_DENY_ENV,
  cloudWebSearchDenied,
  computeMcpOwnership,
  installCloudMcp,
  isWebSearchToolId,
  LOCAL_WEBSEARCH_DENY_ENV,
  localWebSearchDenied,
  type McpOwnership,
  WebSearchSovereigntyError,
} from "./cloud-websearch-kill"

/** alpha 自己写的那份云 server 定义的端点身份(注入面经 ALPHA_CLOUD_MCP_DEF 过河)。 */
const CLOUD_URL = "https://cloud.example/mcp"
const CLOUD_DEF = JSON.stringify({
  type: "remote",
  url: CLOUD_URL,
  enabled: true,
  headers: { Authorization: "Bearer {file:/tmp/alpha-cloud-token}" },
  oauth: false,
})

/** kill-switch:云侧与本地侧同时置位(main 的 applyWebSearchSovereignty 就是这么写的)。 */
const ON = {
  [CLOUD_WEBSEARCH_DENY_ENV]: "1",
  [LOCAL_WEBSEARCH_DENY_ENV]: "1",
  [CLOUD_MCP_SERVER_ENV]: "cloud",
  [CLOUD_MCP_DEF_ENV]: CLOUD_DEF,
}
/** 平台代付、无 kill-switch:只有本地侧置位,云工具是权威通道。 */
const PLATFORM_PAYS = {
  [LOCAL_WEBSEARCH_DENY_ENV]: "1",
  [CLOUD_MCP_SERVER_ENV]: "cloud",
  [CLOUD_MCP_DEF_ENV]: CLOUD_DEF,
}
const OFF = {}

/**
 * 引擎**合并完成后**的配置形状:alpha 注入的云 server + 用户自带的若干第三方 server。
 * ext 的 `config` 钩子拿到的就是这个对象,`computeMcpOwnership()` 从它核验端点身份。
 */
const engineConfig = (servers: Record<string, unknown> = {}) => ({
  mcp: {
    cloud: { type: "remote", url: CLOUD_URL, enabled: true },
    exa: { type: "remote", url: "https://mcp.exa.ai/mcp" },
    ...servers,
  },
})

/** 生产路径的归属快照(`config` 钩子里 `computeMcpOwnership(cfg)` 算出来、存进本实例闭包的同一个值)。 */
const owned = (env: Record<string, string | undefined>, servers?: Record<string, unknown>): McpOwnership =>
  computeMcpOwnership(engineConfig(servers), env)

const siblingCloudTools = [
  "cloud_dispatch",
  "cloud_status",
  "cloud_await",
  "cloud_artifacts",
  "cloud_schedule_create",
  "cloud_schedule_list",
  "cloud_schedule_delete",
]

describe("cloud web search kill switch", () => {
  test("fail-closed:只有缺省/空串/\"0\" 放行(云侧与本地侧同一条规则)", () => {
    for (const [denied, name] of [
      [cloudWebSearchDenied, CLOUD_WEBSEARCH_DENY_ENV],
      [localWebSearchDenied, LOCAL_WEBSEARCH_DENY_ENV],
    ] as const) {
      expect(denied(OFF)).toBe(false)
      expect(denied({ [name]: "" })).toBe(false)
      expect(denied({ [name]: "0" })).toBe(false)
      for (const value of ["1", "true", "yes", "no", "off", "false", " "]) expect(denied({ [name]: value })).toBe(true)
    }
  })

  test("命中云 web search,放过全部兄弟云工具(AC4:不误杀)", () => {
    expect(isWebSearchToolId("cloud_web_search")).toBe(true)
    // 平台改名也得继续命中 —— 闸不许写死单个字面量。
    expect(isWebSearchToolId("cloud_web_search_v2")).toBe(true)
    expect(isWebSearchToolId("websearch")).toBe(true)
    for (const tool of siblingCloudTools) expect(isWebSearchToolId(tool)).toBe(false)
    for (const tool of ["read", "bash", "alpha_ping", "cloud_search_jobs", "webfetch"])
      expect(isWebSearchToolId(tool)).toBe(false)
  })

  // #223 R5 Blocker:通用 Remote MCP 是第三条现存出口。`{"mcp":{"exa":{"type":"remote",
  // "url":"https://mcp.exa.ai/mcp"}}}` 产生的工具 id 带 server 前缀**和**工具名自带后缀。
  test("命中带前后缀的第三方形态(exa_web_search_exa 等)", () => {
    for (const tool of [
      "exa_web_search_exa",
      "exa_websearch",
      "brave_web_search",
      "my-search_web_search_v2",
      "tavily_web_search-preview",
    ])
      expect(isWebSearchToolId(tool)).toBe(true)
    for (const tool of ["exa_deep_researcher_start", "exa_company_research", "exa_crawling", "context7_query-docs"])
      expect(isWebSearchToolId(tool)).toBe(false)
  })

  // #223 R6 Blocker ①:R5 的判据只认 `web_search` 词根,下面四个**合法工具名**实测 denial:null。
  test("R6 回归:合法改名 search_web / web-search / websearchTool / brave-search 都命中", () => {
    for (const tool of [
      "my_search_web",
      "srv_web-search",
      "srv_websearchTool",
      "srv_brave-search",
      "brave-search_brave_web_search",
      "tavily_search",
      "srv_searchWeb",
    ])
      expect([tool, isWebSearchToolId(tool)]).toEqual([tool, true])
    // 误杀防线:带 search 但不是网页搜索的工具照常放行(AC4)。
    for (const tool of [
      "cloud_search_jobs",
      "gdrive_search_files",
      "code_search",
      "srv_semantic_search",
      "srv_search_replace",
    ])
      expect([tool, isWebSearchToolId(tool)]).toEqual([tool, false])
  })

  // #223 R7 out-of-round Minor:判据 ② 是「`search` 与引擎词**相邻**」,不是「同时出现」。
  // 按集合判时下面两个第三方工具都会命中 —— 误杀,与 AC4 反向。
  test("R7 回归:引擎词与 search 不相邻时不命中(brave_translate_and_search / internet_archive_search)", () => {
    for (const tool of [
      "brave_translate_and_search",
      "internet_archive_search",
      "exa_company_search_jobs",
      "online_docs_semantic_search",
    ])
      expect([tool, isWebSearchToolId(tool)]).toEqual([tool, false])
    // 相邻的那一类照旧命中(收窄没有把判据 ② 判空)。
    for (const tool of ["srv_brave_search", "srv_search_brave", "tavily_search", "srv_kagi-search", "srv_ddg_search"])
      expect([tool, isWebSearchToolId(tool)]).toEqual([tool, true])
  })

  // #223 R6 Blocker ①(诚实登记的天花板):非 ASCII 工具名经 `McpCatalog.sanitize` 后只剩下划线,
  // **任何**按名字的分类器都看不见它。ADR-009 已据此收窄宣称 —— 第三方 web-search MCP 不在保证内。
  test("R6 回归(已登记的漏):sanitize 抹平的非 ASCII 名分类不出来", () => {
    const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
    const toolId = `srv_${sanitize("网页搜索")}`
    expect(toolId).toBe("srv_____")
    expect(isWebSearchToolId(toolId)).toBe(false)
  })

  test("闸开时抛,闸关时全放行", () => {
    expect(() => assertWebSearchToolAllowed("cloud_web_search", ON, owned(ON))).toThrow(WebSearchSovereigntyError)
    expect(() => assertWebSearchToolAllowed("cloud_web_search", ON, owned(ON))).toThrow(/do not retry/)
    expect(() => assertWebSearchToolAllowed("cloud_web_search", OFF, owned(OFF))).not.toThrow()
    for (const tool of siblingCloudTools) {
      expect(() => assertWebSearchToolAllowed(tool, ON, owned(ON))).not.toThrow()
      expect(() => assertWebSearchToolAllowed(tool, OFF, owned(OFF))).not.toThrow()
    }
  })
})

// #223 R5 Blocker:主权判决必须覆盖**任何** MCP server 上的 web search,不只是 alpha 自己那个。
describe("第三方 MCP 上的 web search 同受主权判决(R5 Blocker)", () => {
  const thirdParty = ["exa_web_search_exa", "brave_web_search", "tavily_websearch"]

  test("平台代付(无 kill-switch):第三方全关,alpha 治理的云工具**不**关", () => {
    for (const tool of thirdParty) {
      expect(() => assertWebSearchToolAllowed(tool, PLATFORM_PAYS, owned(PLATFORM_PAYS))).toThrow(
        WebSearchSovereigntyError,
      )
      expect(() => assertWebSearchToolAllowed(tool, PLATFORM_PAYS, owned(PLATFORM_PAYS))).toThrow(/do not retry/)
    }
    // AC4:平台代付时云工具是权威通道,闸不许误杀它,也不许误杀兄弟工具。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, owned(PLATFORM_PAYS))).not.toThrow()
    for (const tool of siblingCloudTools)
      expect(() => assertWebSearchToolAllowed(tool, PLATFORM_PAYS, owned(PLATFORM_PAYS))).not.toThrow()
  })

  test("kill-switch:第三方与云工具一起关", () => {
    for (const tool of [...thirdParty, "cloud_web_search"])
      expect(() => assertWebSearchToolAllowed(tool, ON, owned(ON))).toThrow(WebSearchSovereigntyError)
    for (const tool of siblingCloudTools) expect(() => assertWebSearchToolAllowed(tool, ON, owned(ON))).not.toThrow()
  })

  test("登出 / BYOK(两个信号都不置位):第三方 web search 照常可用", () => {
    for (const tool of thirdParty) expect(() => assertWebSearchToolAllowed(tool, OFF, owned(OFF))).not.toThrow()
  })

  test("治理例外只认注入面点名的那个 server,不写死 \"cloud\" 字面量", () => {
    const renamed = { ...PLATFORM_PAYS, [CLOUD_MCP_SERVER_ENV]: "alphacloud" }
    const config = { mcp: { alphacloud: { type: "remote", url: CLOUD_URL }, cloud: { type: "remote", url: CLOUD_URL } } }
    const ownership = computeMcpOwnership(config, renamed)
    expect(ownership).toEqual({ governed: ["alphacloud"], foreign: ["cloud"] })
    expect(() => assertWebSearchToolAllowed("alphacloud_web_search", renamed, ownership)).not.toThrow()
    // 名字没对上就不是治理通道 —— 一个自称 cloud、甚至照抄了 alpha URL 的第三方 server 拿不到豁免。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", renamed, ownership)).toThrow(WebSearchSovereigntyError)
  })

  test("注入面没点名任何云 server 时(登出态误置信号)倒向 fail-closed", () => {
    const env = { [LOCAL_WEBSEARCH_DENY_ENV]: "1" }
    expect(() => assertWebSearchToolAllowed("cloud_web_search", env, owned(env))).toThrow(WebSearchSovereigntyError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #223 R6 Blocker ②:治理例外必须绑定**不可由 MCP 名称伪造的端点身份**。
//
// R5 的判据是 `tool.startsWith("${server}_")` —— 名字前缀,不是 server 身份。R6 实跑证明:
// 一个叫 `cloud_attacker` 的用户 server 上的 `web_search` 因此被当成治理云工具直接放行。
// 现在判据是「名字等于注入面点名的那个 **且** 配置里那条定义的 URL 与 alpha 自己写的逐字相同」,
// 并且工具归属的**任何歧义**都倒向 fail-closed。
// ─────────────────────────────────────────────────────────────────────────────
describe("治理豁免绑定端点身份,名字伪造不了(R6 Blocker)", () => {
  test("端点身份核验:URL 对上才算治理 server", () => {
    expect(owned(PLATFORM_PAYS)).toEqual({ governed: ["cloud"], foreign: ["exa"] })
    // 同名但换了 URL(managed / MDM 之类的后置来源覆盖回去)⇒ 不再是治理 server,fail-closed。
    const hijacked = computeMcpOwnership(
      { mcp: { cloud: { type: "remote", url: "https://attacker.example/mcp" } } },
      PLATFORM_PAYS,
    )
    expect(hijacked).toEqual({ governed: [], foreign: ["cloud"] })
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, hijacked)).toThrow(
      WebSearchSovereigntyError,
    )
    // DEF 缺席 / 坏 JSON / 不是 remote ⇒ 没有可核验的身份,一个 server 都不治理。
    for (const def of [undefined, "{not json", '"a string"', JSON.stringify({ type: "local", command: ["x"] })])
      expect(owned({ ...PLATFORM_PAYS, [CLOUD_MCP_DEF_ENV]: def }).governed).toEqual([])
  })

  test("R6 回归:`cloud_attacker` 拿不到豁免(R5 下它被当成治理云工具放行)", () => {
    const servers = { cloud_attacker: { type: "remote", url: "https://attacker.example/mcp" } }
    const ownership = owned(PLATFORM_PAYS, servers)
    expect(ownership.foreign).toContain("cloud_attacker")
    expect(() => assertWebSearchToolAllowed("cloud_attacker_web_search", PLATFORM_PAYS, ownership)).toThrow(
      WebSearchSovereigntyError,
    )
    // 真的治理云工具照常放行(闸没有因此变成一刀切)。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, ownership)).not.toThrow()
  })

  test("R6 回归:`<server>_<tool>` 边界歧义倒向 fail-closed(cloud_web + search)", () => {
    // 一个叫 `cloud_web` 的 server 上的 `search` 与治理 server 上的 `web_search` 拼出同一个 id。
    const ownership = owned(PLATFORM_PAYS, { cloud_web: { type: "remote", url: "https://attacker.example/mcp" } })
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, ownership)).toThrow(
      WebSearchSovereigntyError,
    )
  })

  test("R6 回归:运行时 `POST /mcp` 新装的 server(配置里没有)一律拿不到豁免", () => {
    const ownership = owned(PLATFORM_PAYS)
    // 归属不在快照里 ⇒ 没有候选 ⇒ 豁免不给。
    for (const tool of ["runtime_web_search", "cloudx_web_search", "cloud-2_web_search"])
      expect(() => assertWebSearchToolAllowed(tool, PLATFORM_PAYS, ownership)).toThrow(WebSearchSovereigntyError)
  })

  // 诚实登记(R6 D-1 收窄后落在「用户自己新装的第三方 MCP」那一类):`POST /mcp` 用**同一个名字**
  // 替换掉已连的客户端后,上游没有任何接口把「当前活着的 server 定义」暴露给插件 —— 配置快照
  // 仍是 alpha 那份,ext 从名字上分辨不出来。收编它要动 handlers/mcp.ts / mcp/index.ts,不在本票范围。
  test("残留(登记,非闭合):同名 `POST /mcp` add 替换客户端后,豁免仍按配置快照给", () => {
    const ownership = owned(PLATFORM_PAYS)
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, ownership)).not.toThrow()
    // 但 kill-switch 下它照样被关 —— 豁免的唯一效果是「代付态放行」,不是「越过 kill-switch」。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", ON, owned(ON))).toThrow(WebSearchSovereigntyError)
  })

  test("config 钩子没跑过 ⇒ 没有任何治理 server(模块默认值 fail-closed)", () => {
    // 不传 ownership:本实例的 config 钩子还没算出归属时,豁免一律不给(默认实参 = UNVERIFIED)。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, { governed: [], foreign: [] })).toThrow(
      WebSearchSovereigntyError,
    )
  })
})

// 反向测试:R2/R3 的判据是「可覆盖的 permission 不能证明 kill-switch 真能关」。这里复刻引擎两条
// 云工具执行链的**次序**(#1129 起:identity ask → hook → callTool),把 ask 配成「后置
// agent/session allow + approved 全开」的最有利于绕过的状态,断言 callTool 一次都没被打到 ——
// ask 先跑并且放行了,也照样到不了传输:kill-switch 钩子不是 permission,不参与被覆盖。
describe("后置 allow / approved 覆盖不了 kill-switch", () => {
  type Chain = { calls: string[]; run: (tool: string) => void }

  /** `session/tools.ts`(register 的 identityGate)与 `tool/code-mode.ts` 的共同骨架(#1129 / #724 §6):
   *  先 identity ask,再 trigger 钩子,再 callTool。 */
  const engineChain = (env: Record<string, string | undefined>): Chain => {
    const calls: string[] = []
    const ownership = owned(env)
    return {
      calls,
      run(tool) {
        // 最有利于绕过的 permission 状态:全局 deny 之后还有 agent wildcard allow、持久化到
        // session 的 allow、以及 discharge ask 的 session grant —— 三条都放行。
        const ruleset = [
          { action: tool, effect: "deny" },
          { action: "*", effect: "allow" }, // 后加载的 agent wildcard
          { action: tool, effect: "allow" }, // 持久化进 session 的 permission
        ]
        const approved = true
        const decision = approved ? "allow" : ruleset.findLast((rule) => rule.action === tool || rule.action === "*")!.effect
        calls.push(`ask:${decision}`)
        if (decision !== "allow") return
        assertWebSearchToolAllowed(tool, env, ownership) // = plugin.trigger("tool.execute.before", ...)
        calls.push(`callTool:${tool}`)
      },
    }
  }

  test("kill-switch 下 cloud_web_search 到不了 callTool(两条链同一个骨架)", () => {
    const chain = engineChain(ON)
    expect(() => chain.run("cloud_web_search")).toThrow(WebSearchSovereigntyError)
    expect(chain.calls).toEqual(["ask:allow"]) // ask 已经放行,callTool 仍为零 —— 覆盖失败
  })

  test("同一条链上,兄弟云工具照常执行", () => {
    const chain = engineChain(ON)
    for (const tool of siblingCloudTools) chain.run(tool)
    expect(chain.calls.filter((c) => c.startsWith("callTool:"))).toEqual(
      siblingCloudTools.map((tool) => `callTool:${tool}`),
    )
  })

  test("闸关时 cloud_web_search 照常执行(不是永久禁用)", () => {
    const chain = engineChain(OFF)
    chain.run("cloud_web_search")
    expect(chain.calls).toEqual(["ask:allow", "callTool:cloud_web_search"])
  })
})

// 上面那个骨架的前提是:钩子**无条件**先于传输执行,任何 permission 结论都插不进钩子与传输
// 之间去改写它。#1129(#724 §6)把 identity ask 上移到钩子之前(E1/E3 在 register 的
// identityGate、E4 在 invokeChildTool 顶部),钩子与传输之间从此不允许再出现任何 ask ——
// 那正是旧形态里「once 被问两次 / permission 站在钩子之后」的位置。上游 sync 一旦把 trigger
// 挪到传输之后、删掉、或把 ask 塞回钩子后面,这里必须立刻变红。
describe("上游次序前提(#1129:identity ask 早于 trigger,trigger 早于传输)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")

  test("普通 MCP 链:identity 闸在 register 咽喉上,MCP 循环里 trigger 直达传输、其后再无 ask", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/session/tools.ts"), "utf8")
    // ① register 咽喉上的 identity 闸在:闸在 wrapper、钩子在被包的 execute 内,
    //    「ask 早于 trigger」是结构性的,不靠行序纪律。#1129 reopen 后 wrapper 里的载体
    //    是共享 gate(gateToolExecution:文档轴 deny → 单次 Permission.ask),锚点随之换。
    const gate = body.indexOf("const identityGate")
    expect(gate).toBeGreaterThanOrEqual(0)
    const registerFn = body.indexOf("const register =", gate)
    expect(registerFn).toBeGreaterThan(gate)
    const gateCall = body.indexOf("AlphaToolPolicyGate.gateToolExecution(", gate)
    expect(gateCall).toBeGreaterThan(gate)
    expect(gateCall).toBeLessThan(registerFn)
    expect(body.indexOf("identityGate(value, display)", registerFn)).toBeGreaterThan(registerFn)
    // ①b gate 模块内部:deny 判定之后恰有一次 permission.ask(单一问询点;findLast 组合在其中)。
    const gateBody = readFileSync(join(repoRoot, "packages/opencode/src/permission/alpha-tool-policy-gate.ts"), "utf8")
    const gateFn = gateBody.indexOf("export const gateToolExecution")
    expect(gateFn).toBeGreaterThanOrEqual(0)
    const gateAsk = gateBody.indexOf("input.permission.ask(", gateFn)
    expect(gateAsk).toBeGreaterThan(gateFn)
    expect(gateBody.indexOf("input.permission.ask(", gateAsk + 1)).toBe(-1)
    // ② MCP 循环:trigger 之后直达传输,不许再有第二个 ask(旧的重复 canonical ask 位点)。
    const loop = body.indexOf("McpCatalog.convertTool(")
    expect(loop).toBeGreaterThanOrEqual(0)
    const trigger = body.indexOf('"tool.execute.before"', loop)
    expect(trigger).toBeGreaterThan(loop)
    const transport = body.indexOf("Effect.promise(() => execute(args, opts))", trigger)
    expect(transport).toBeGreaterThan(trigger)
    const staleAsk = body.indexOf("ctx.ask(", trigger)
    expect(staleAsk === -1 || staleAsk > transport).toBe(true)
    const staleGate = body.indexOf("gateToolExecution(", trigger)
    expect(staleGate === -1 || staleGate > transport).toBe(true)
  })

  test("code-mode 链:invokeChildTool 里 ask 在 trigger 之前,trigger 在 callTool 之前", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/tool/code-mode.ts"), "utf8")
    const fn = body.indexOf("invokeChildTool = Effect.fn")
    expect(fn).toBeGreaterThanOrEqual(0)
    // #1129 reopen:载体 = 共享 gate(文档轴 deny → 单次 Permission.ask),仍必须先于 trigger。
    const ask = body.indexOf("AlphaToolPolicyGate.gateToolExecution(", fn)
    const trigger = body.indexOf('"tool.execute.before"', fn)
    const callTool = body.indexOf(".callTool(", fn)
    expect(ask).toBeGreaterThan(fn)
    expect(trigger).toBeGreaterThan(ask)
    expect(callTool).toBeGreaterThan(trigger)
  })

  test("Plugin.trigger 不吞钩子抛出的错(Effect.promise = 抛即 defect)", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf8")
    const trigger = body.indexOf('Effect.fn("Plugin.trigger")')
    expect(trigger).toBeGreaterThanOrEqual(0)
    const invoke = body.indexOf("Effect.promise(async () => fn(input, output))", trigger)
    expect(invoke).toBeGreaterThan(trigger)
    // trigger 体内不得出现任何吞错(否则钩子抛出会被静默降级成「照常执行」)
    const tail = body.slice(trigger, invoke + 400)
    for (const swallow of ["Effect.ignore", "catchAll", "Effect.orElse", "Effect.either"])
      expect(tail).not.toContain(swallow)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #223 R4:ext 装载握手。上一轮的 fail-closed 判据是 main 侧「ext bundle 路径存不存在」——
// R4 给出三条路径仍在、钩子却不存在的真实情形。下面每一条都真跑一遍:走的是**真实的**
// `AlphaExt`(动态 import 本包源码,与引擎装它的方式同款)与真实的失败模块,不是替身。
//
// R5 收紧:握手的产物从「翻开一个 enabled:false 的条目」改成「把定义装进配置」——
// `enabled:false` 会被 `/mcp/:name/connect` 无条件复制成 `enabled:true`(R5 Major 回归)。
// ─────────────────────────────────────────────────────────────────────────────

describe("installCloudMcp 单元判据", () => {
  const tokenFile = join(tmpdir(), `alpha-ext-token-${process.pid}`)
  // `#733` B1(审计 Blocker):alpha 治理的云 server **走标准 MCP OAuth**,定义里没有任何凭证通道。
  // 这个夹具从前是 `headers.Authorization + oauth:false`,于是即便本文件全绿,
  // 「最终写回的那一份不许带静态 bearer」这条 AC **一个闸都没有** ——
  // 实测把写回行改成「DEF 没有 headers 就补一个 Authorization」,本文件 42 条照样全绿
  //(因为夹具自己就带 headers,那条分支根本不执行)。夹具接受的形状 = 这道闸真正的边界。
  const def = JSON.stringify({
    type: "remote",
    url: "https://cloud.example/mcp",
    enabled: true,
    oauth: {
      clientId: "https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json",
      redirectUri: "http://127.0.0.1:19876/callback",
    },
  })
  const armed = { [CLOUD_MCP_ARM_ENV]: "cloud", [CLOUD_MCP_DEF_ENV]: def }
  const readToken = () => "tok-live"

  test("装的是完整定义,且云 server 那一份零凭证通道(OAuth 形态)", () => {
    const cfg: { mcp?: Record<string, unknown> } = { mcp: { other: { type: "local", enabled: false } } }
    expect(installCloudMcp(cfg, armed, readToken)).toBe("cloud")
    expect(cfg.mcp!.cloud).toEqual({
      type: "remote",
      url: "https://cloud.example/mcp",
      enabled: true,
      oauth: {
        clientId: "https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json",
        redirectUri: "http://127.0.0.1:19876/callback",
      },
    })
    // 写回时**不许**凭空长出凭证通道(`toEqual` 已排他,键名单再点一次名)。
    expect(Object.keys(cfg.mcp!.cloud as object).sort()).toEqual(["enabled", "oauth", "type", "url"])
    // 别人的 disabled 条目(账本覆盖 / XDG 默认拒绝)不归本握手管。
    expect(cfg.mcp!.other).toEqual({ type: "local", enabled: false })
  })

  // `{file:}` 解析仍然要有闸 —— 但它是**通用 JSON** 能力,不再挂在云 server 上放行静态 bearer。
  // 拆开之后:上面那条钉「云 server 长什么样」,这条钉「带引用的定义会被解析」。
  const genericRefDef = JSON.stringify({
    type: "remote",
    url: "https://third-party.example/mcp",
    enabled: true,
    headers: { "X-Api-Key": `{file:${tokenFile}}` },
  })
  const armedGeneric = { [CLOUD_MCP_ARM_ENV]: "cloud", [CLOUD_MCP_DEF_ENV]: genericRefDef }

  test("通用能力:DEF 里的 {file:} 引用在这一层才被解析(config 钩子拿到的已是解析后对象)", () => {
    const cfg: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(cfg, armedGeneric, readToken)).toBe("cloud")
    expect(cfg.mcp!.cloud).toEqual({
      type: "remote",
      url: "https://third-party.example/mcp",
      enabled: true,
      headers: { "X-Api-Key": "tok-live" },
    })
  })

  test("ARM 与 DEF 必须成对;缺一个就什么都不装", () => {
    const onlyArm: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(onlyArm, { [CLOUD_MCP_ARM_ENV]: "cloud" }, readToken)).toBeUndefined()
    expect(onlyArm.mcp).toBeUndefined()

    const onlyDef: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(onlyDef, { [CLOUD_MCP_DEF_ENV]: def }, readToken)).toBeUndefined()
    expect(onlyDef.mcp).toBeUndefined()

    const nothing: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(nothing, {}, readToken)).toBeUndefined()
    expect(nothing.mcp).toBeUndefined()
  })

  test("坏 DEF(非 JSON / 非对象)fail-closed:不装,也不抛", () => {
    for (const raw of ["{not json", '"a string"', "[1,2]", "null"]) {
      const cfg: { mcp?: Record<string, unknown> } = {}
      expect(installCloudMcp(cfg, { [CLOUD_MCP_ARM_ENV]: "cloud", [CLOUD_MCP_DEF_ENV]: raw }, readToken)).toBeUndefined()
      expect(cfg.mcp).toBeUndefined()
    }
  })

  test("带 {file:} 的定义在密钥文件读不到时 fail-closed:不装一个没有凭据的 server", () => {
    // 用 `armedGeneric`:云 server 自己已经没有引用可解了(走 OAuth),这条守的是
    // 「任何带引用的定义读不到就整个不装」——删掉它 = 对未来带引用的定义默认放行。
    const cfg: { mcp?: Record<string, unknown> } = {}
    const missing = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    }
    expect(installCloudMcp(cfg, armedGeneric, missing)).toBeUndefined()
    expect(cfg.mcp).toBeUndefined()
  })

  test("配置里根本没有 mcp 段也不抛;cfg 不是对象则不动", () => {
    const empty: { mcp?: Record<string, unknown> } = {}
    expect(installCloudMcp(empty, armed, readToken)).toBe("cloud")
    expect(empty.mcp!.cloud).toBeDefined()
    expect(installCloudMcp(undefined, armed, readToken)).toBeUndefined()
    expect(installCloudMcp(null, armed, readToken)).toBeUndefined()
  })
})

describe("ext 缺席三态:云 MCP 定义根本不进配置(#223 R4→R5 云 kill-switch)", () => {
  let root = ""
  let savedRoot: string | undefined
  let savedArm: string | undefined
  let savedDef: string | undefined
  let tokenFile = ""

  // `#733`:真实注入面在 kill-switch 下托管的形状 —— OAuth 对象,零凭证通道。
  const cloudDef = () => ({
    type: "remote",
    url: "https://cloud.example/mcp",
    enabled: true,
    oauth: {
      clientId: "https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json",
      redirectUri: "http://127.0.0.1:19876/callback",
    },
  })

  beforeEach(() => {
    savedRoot = process.env.ALPHA_GLOBAL_DIR
    savedArm = process.env[CLOUD_MCP_ARM_ENV]
    savedDef = process.env[CLOUD_MCP_DEF_ENV]
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-arm-")))
    process.env.ALPHA_GLOBAL_DIR = root
    tokenFile = join(root, "ALPHA_CLOUD_TOKEN")
    writeFileSync(tokenFile, "tok-live\n")
    // main 侧 injectAlphaConfig 在 kill-switch 下置位的握手通道(定义只在 env 里托管)。
    process.env[CLOUD_MCP_ARM_ENV] = "cloud"
    process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify(cloudDef())
  })
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = savedRoot
    if (savedArm === undefined) delete process.env[CLOUD_MCP_ARM_ENV]
    else process.env[CLOUD_MCP_ARM_ENV] = savedArm
    if (savedDef === undefined) delete process.env[CLOUD_MCP_DEF_ENV]
    else process.env[CLOUD_MCP_DEF_ENV] = savedDef
  })

  /**
   * 注入面在 kill-switch 下写出的配置(#223 R6 Major 后的真实形状):真定义不进配置,写的是
   * 一份**中和条目** —— `ui-mac/src/main/cloud-web-search.ts` 的 `WITHHELD_CLOUD_MCP`。它存在的
   * 唯一理由是压过继承来源(global / alpha.jsonc / 项目)里的同名定义;URL 不可解析、enabled:false。
   */
  const WITHHELD = {
    type: "remote",
    url: "http://127.0.0.1:1/alpha-cloud-withheld",
    enabled: false,
    oauth: false,
  } as const
  const injectedConfig = (): {
    mcp: Record<string, { type?: string; url?: string; enabled?: boolean; headers?: Record<string, string> }>
  } => ({
    mcp: { cloud: { ...WITHHELD } },
  })

  const pluginInput = () => ({
    client: {} as never,
    directory: root,
    worktree: root,
    project: { id: "prj_arm_test" },
    $: undefined,
  })

  /**
   * 引擎装载外部插件 + 派发 config 钩子的判定形状(`opencode/src/plugin/index.ts`)。
   * 三个前提各由下面 "上游前提(装载路径)" 一组对源码锁住,`pure` 的真实解析由
   * `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 用真 RuntimeFlags 断言。
   */
  async function engineLoadAndConfigure(
    cfg: unknown,
    opts: { pure: boolean; specs: Array<() => Promise<{ default: (input: unknown) => Promise<unknown> }>> },
  ) {
    const hooks: Array<Record<string, unknown>> = []
    // plugin/index.ts: `const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])`
    for (const load of opts.pure ? [] : opts.specs) {
      let mod: { default: (input: unknown) => Promise<unknown> }
      // PluginLoader.loadExternal:import 失败经 report.error 上报后跳过(log-and-continue)
      try {
        mod = await load()
      } catch {
        continue
      }
      // plugin/index.ts: `Effect.tryPromise({ try: () => plugin(input) })` + `Effect.catch(() => Effect.void)`
      try {
        hooks.push((await mod.default(pluginInput())) as Record<string, unknown>)
      } catch {
        continue
      }
    }
    // plugin/index.ts: "Notify plugins of current config" —— 逐个 hook 调 config
    for (const hook of hooks) await (hook["config"] as ((cfg: unknown) => Promise<void>) | undefined)?.(cfg)
    return hooks
  }

  const realExt = () => import("./plugin") as Promise<{ default: (input: unknown) => Promise<unknown> }>

  test("基线:ext 真的装载 ⇒ 云 server 被装进配置(否则下面三条是空的)", async () => {
    const cfg = injectedConfig()
    const hooks = await engineLoadAndConfigure(cfg, { pure: false, specs: [realExt] })

    expect(hooks).toHaveLength(1)
    // 装上的同一个 hooks 对象上,那道不可覆盖的闸确实在。
    expect(typeof hooks[0]!["tool.execute.before"]).toBe("function")
    expect(cfg.mcp.cloud).toMatchObject({ type: "remote", enabled: true })
    // `#733`:装进去的是 OAuth 形态,**没有** headers —— 这是「删静态 bearer」在
    // 真实装载路径(引擎装 ext → 派发 config 钩子 → installCloudMcp 写回)上的落点。
    expect(cfg.mcp.cloud!.headers).toBeUndefined()
    expect(cfg.mcp.cloud).toEqual({
      type: "remote",
      url: "https://cloud.example/mcp",
      enabled: true,
      oauth: {
        clientId: "https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json",
        redirectUri: "http://127.0.0.1:19876/callback",
      },
    })
  })

  test("① OPENCODE_PURE:引擎整个跳过外部插件 ⇒ 配置里只剩中和条目", async () => {
    const cfg = injectedConfig()
    const hooks = await engineLoadAndConfigure(cfg, { pure: true, specs: [realExt] })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })

  test("② bundle import 失败(log-and-continue)⇒ 配置里只剩中和条目", async () => {
    const broken = join(root, "broken-bundle.mjs")
    writeFileSync(broken, 'throw new Error("bundle is corrupt")\n')
    const cfg = injectedConfig()

    const hooks = await engineLoadAndConfigure(cfg, {
      pure: false,
      specs: [() => import(broken) as Promise<{ default: (input: unknown) => Promise<unknown> }>],
    })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })

  test("③ 插件初始化抛错(log-and-continue)⇒ 配置里只剩中和条目", async () => {
    const failing = join(root, "init-throws.mjs")
    writeFileSync(failing, 'export default async () => { throw new Error("AlphaExt init failed") }\n')
    const cfg = injectedConfig()

    const hooks = await engineLoadAndConfigure(cfg, {
      pure: false,
      specs: [() => import(failing) as Promise<{ default: (input: unknown) => Promise<unknown> }>],
    })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })

  // ext 缺席 ⇒ 配置里没有可复活的定义,只有一个连不上任何东西的中和条目。`MCP.connect()` 的
  // 复活路径与多源继承由 `packages/opencode/test/mcp/alpha-cloud-mcp-revival.test.ts` 与
  // `packages/opencode/test/mcp/alpha-cloud-mcp-multisource.test.ts` 用真实 MCP lifecycle + HTTP 断言。
  test("ext 缺席时配置里连一个真 URL / Authorization 头都不存在(R5 Major:热连无物可连)", async () => {
    const cfg = injectedConfig()
    await engineLoadAndConfigure(cfg, { pure: true, specs: [realExt] })
    expect(JSON.stringify(cfg)).not.toContain("cloud.example")
    expect(JSON.stringify(cfg)).not.toContain("Authorization")
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })

  // 反向:握手通道没置位(= 注入面没走 kill-switch 路径)时,ext 装载也不该凭空装一个云 server。
  test("没有 arm 通道时 ext 什么也不装", async () => {
    delete process.env[CLOUD_MCP_ARM_ENV]
    const cfg = injectedConfig()
    await engineLoadAndConfigure(cfg, { pure: false, specs: [realExt] })
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })

  test("只有 arm 没有 def(伪造半个通道)⇒ 什么也不装", async () => {
    delete process.env[CLOUD_MCP_DEF_ENV]
    const cfg = injectedConfig()
    await engineLoadAndConfigure(cfg, { pure: false, specs: [realExt] })
    expect(cfg.mcp.cloud).toEqual({ ...WITHHELD })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #223 R7 Blocker:治理归属是**每个 AlphaExt 实例**的状态,不是模块状态。
//
// 插件模块由 Bun 动态 import **缓存**(一个进程只有一份模块),而 Plugin / MCP 状态按 directory
// 建实例 —— 快照存在模块级 `let` 上时,后跑的实例会把先跑的实例的归属覆盖掉。R7 的只读探针实测:
// 实例 A 记录正常 `cloud` 后 `cloud_web_search` 放行;实例 B 只要多记一个 foreign `cloud_web`,
// A 的**同一个** alpha 云工具立刻被误拒 —— 一个项目改变了另一个项目权威云工具的可用性,违反本票
// 对治理云 server 的保证与 AC4「不误杀」。
//
// 下面这条跑的是**真的** `AlphaExt`:同一个(被缓存的)模块 import 两次、各带自己的 directory,
// 与引擎并存两个项目实例同款。判据 = B 的 foreign server 改不动 A 的判决,两个方向都验。
// ─────────────────────────────────────────────────────────────────────────────
describe("跨实例隔离:治理归属按实例闭包,不串扰(#223 R7 Blocker)", () => {
  const saved: Record<string, string | undefined> = {}
  let root = ""
  let dirA = ""
  let dirB = ""

  /** alpha 自己那份定义的端点身份(A、B 两个项目看到的是同一个 alpha 云 server)。 */
  const GOVERNED = { type: "remote", url: CLOUD_URL, enabled: true } as const
  /** B 项目里用户自己配的第三方 server —— 名字前缀正好与 `cloud_web_search` 的边界歧义撞上。 */
  const FOREIGN = { type: "remote", url: "https://attacker.example/mcp" } as const

  beforeEach(() => {
    for (const key of ["ALPHA_GLOBAL_DIR", LOCAL_WEBSEARCH_DENY_ENV, CLOUD_MCP_SERVER_ENV, CLOUD_MCP_DEF_ENV])
      saved[key] = process.env[key]
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-xtalk-")))
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-projA-")))
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-projB-")))
    process.env.ALPHA_GLOBAL_DIR = root
    // 平台代付(无 kill-switch):治理云工具是权威通道,必须放行;第三方 web search 一律关。
    process.env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
    process.env[CLOUD_MCP_SERVER_ENV] = "cloud"
    process.env[CLOUD_MCP_DEF_ENV] = CLOUD_DEF
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  type Hooks = Record<string, unknown>
  /** 引擎按 directory 建实例:同一个模块 import 两次(第二次命中 import 缓存 —— 串扰的载体)。 */
  const instance = async (directory: string): Promise<Hooks> => {
    const mod = (await import("./plugin")) as { default: (input: unknown) => Promise<Hooks> }
    return mod.default({
      client: {} as never,
      directory,
      worktree: directory,
      project: { id: `prj_${directory}` },
      $: undefined,
    })
  }
  const configure = (hooks: Hooks, cfg: unknown) => (hooks["config"] as (cfg: unknown) => Promise<void>)(cfg)
  /** 判决:`null` = 放行,否则是拒绝理由(错误名)。 */
  const verdict = async (hooks: Hooks, tool: string): Promise<string | null> => {
    try {
      await (hooks["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>)(
        { tool, sessionID: "ses_xtalk", callID: "call_xtalk" },
        { args: {} },
      )
      return null
    } catch (error) {
      return error instanceof Error ? error.name : String(error)
    }
  }

  test("B 记录一个 foreign `cloud_web` 后,A 的 cloud_web_search 仍然放行", async () => {
    const a = await instance(dirA)
    const b = await instance(dirB)

    // 项目 A:只有 alpha 那份治理云 server ⇒ 权威通道放行(基线,否则下面的判据是空的)。
    await configure(a, { mcp: { cloud: { ...GOVERNED } } })
    expect(await verdict(a, "cloud_web_search")).toBeNull()

    // 项目 B:同一份治理云 server + 用户自己配的 `cloud_web` ⇒ B 侧归属歧义,fail-closed。
    await configure(b, { mcp: { cloud: { ...GOVERNED }, cloud_web: { ...FOREIGN } } })
    expect(await verdict(b, "cloud_web_search")).toBe("WebSearchSovereigntyError")

    // 修复前:B 的 config 钩子覆盖了模块级快照 ⇒ A 的同一个工具被误拒(跨项目串扰)。
    expect(await verdict(a, "cloud_web_search")).toBeNull()
    // 反向同理:A 重跑 config 也不能把豁免漏给 B。
    await configure(a, { mcp: { cloud: { ...GOVERNED } } })
    expect(await verdict(b, "cloud_web_search")).toBe("WebSearchSovereigntyError")
    expect(await verdict(a, "cloud_web_search")).toBeNull()
  })

  test("两个实例的 foreign server 互不可见(A 的第三方 web search 关,B 的兄弟工具不受影响)", async () => {
    const a = await instance(dirA)
    const b = await instance(dirB)
    await configure(a, { mcp: { cloud: { ...GOVERNED }, exa: { type: "remote", url: "https://mcp.exa.ai/mcp" } } })
    await configure(b, { mcp: { cloud: { ...GOVERNED } } })

    // 第三方 web search 在两侧都关(判据是工具形态,与归属快照无关)。
    for (const hooks of [a, b]) expect(await verdict(hooks, "exa_web_search_exa")).toBe("WebSearchSovereigntyError")
    // AC4:兄弟云工具在两侧都照常执行(`cloud_dispatch` 除外 —— 同一钩子的下一句是**契约**校验,
    // 空 args 会被它按 CloudJobRequestV1 拒掉,那与本闸无关)。
    for (const hooks of [a, b])
      for (const tool of siblingCloudTools.filter((tool) => tool !== "cloud_dispatch"))
        expect([tool, await verdict(hooks, tool)]).toEqual([tool, null])
  })
})

// 上面那个 mini-loader 的三个前提。上游 sync 改掉任何一条,握手的 fail-closed 语义就变了,必须变红。
describe("上游前提(装载路径)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")
  const pluginIndex = () => readFileSync(join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf8")

  test("pure 时外部插件被整个跳过(R4 绕过链第 3 环)", () => {
    expect(pluginIndex()).toContain("const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])")
  })

  test("OPENCODE_PURE 就是 pure 这个 flag 的来源(第 2 环)", () => {
    const flags = readFileSync(join(repoRoot, "packages/opencode/src/effect/runtime-flags.ts"), "utf8")
    expect(flags).toContain('pure: bool("OPENCODE_PURE")')
  })

  test("插件装载失败是 log-and-continue,不是 fail-closed(所以判据不能是「路径存在」)", () => {
    const body = pluginIndex()
    const load = body.indexOf('Effect.logError("failed to load plugin"')
    expect(load).toBeGreaterThanOrEqual(0)
    // tapError 之后紧跟 Effect.catch(() => …) —— 装载失败被吞掉,引擎照常启动。
    expect(body.slice(load, load + 300)).toContain("Effect.catch(")
  })

  test("config 钩子确实会被派发到每个已装载插件(握手的载体)", () => {
    const body = pluginIndex()
    const notify = body.indexOf("// Notify plugins of current config")
    expect(notify).toBeGreaterThanOrEqual(0)
    expect(body.slice(notify, notify + 300)).toContain("config?.(cfg)")
  })
})
