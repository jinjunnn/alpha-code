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

/** 生产路径的归属快照(`config` 钩子里 `recordMcpOwnership(cfg)` 算出来的同一个值)。 */
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
    // 不传 ownership:模块里还没有 recordMcpOwnership 的结果时,豁免一律不给。
    expect(() => assertWebSearchToolAllowed("cloud_web_search", PLATFORM_PAYS, { governed: [], foreign: [] })).toThrow(
      WebSearchSovereigntyError,
    )
  })
})

// 反向测试:R2/R3 的判据是「可覆盖的 permission 不能证明 kill-switch 真能关」。这里复刻引擎两条
// 云工具执行链的**次序**(hook → ask → callTool),把 ask 配成「后置 agent/session allow +
// approved 全开」的最有利于绕过的状态,断言 callTool 一次都没被打到。
describe("后置 allow / approved 覆盖不了 kill-switch", () => {
  type Chain = { calls: string[]; run: (tool: string) => void }

  /** `session/tools.ts` 与 `tool/code-mode.ts` 的共同骨架:先 trigger 钩子,再 ask,再 callTool。 */
  const engineChain = (env: Record<string, string | undefined>): Chain => {
    const calls: string[] = []
    const ownership = owned(env)
    return {
      calls,
      run(tool) {
        assertWebSearchToolAllowed(tool, env, ownership) // = plugin.trigger("tool.execute.before", ...)
        // 最有利于绕过的 permission 状态:全局 deny 之后还有 agent wildcard allow、持久化到
        // session 的 allow、以及排在整个 ruleset 之后的 approved —— 三条都放行。
        const ruleset = [
          { action: tool, effect: "deny" },
          { action: "*", effect: "allow" }, // 后加载的 agent wildcard
          { action: tool, effect: "allow" }, // 持久化进 session 的 permission
        ]
        const approved = true
        const decision = approved ? "allow" : ruleset.findLast((rule) => rule.action === tool || rule.action === "*")!.effect
        calls.push(`ask:${decision}`)
        if (decision !== "allow") return
        calls.push(`callTool:${tool}`)
      },
    }
  }

  test("kill-switch 下 cloud_web_search 到不了 callTool(两条链同一个骨架)", () => {
    const chain = engineChain(ON)
    expect(() => chain.run("cloud_web_search")).toThrow(WebSearchSovereigntyError)
    expect(chain.calls).toEqual([]) // 连 ask 都没走到,approved 无从生效
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

// 上面那个骨架的前提是引擎**真的**先触发钩子再 ask。这条锁把该前提机械化:上游 sync 一旦把
// trigger 挪到 ask 之后(或删掉),云侧最终闸就退化成可覆盖的 permission,必须立刻变红。
describe("上游次序前提(trigger 早于 ask)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")
  const between = (body: string, from: number) => {
    const trigger = body.indexOf('"tool.execute.before"', from)
    const ask = body.indexOf("ctx.ask(", trigger)
    return { trigger, ask }
  }

  test("普通 MCP 链:session/tools.ts 的 MCP 循环里 trigger 在 ask 之前", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/session/tools.ts"), "utf8")
    const loop = body.indexOf("McpCatalog.convertTool(")
    expect(loop).toBeGreaterThanOrEqual(0)
    const { trigger, ask } = between(body, loop)
    expect(trigger).toBeGreaterThan(loop)
    expect(ask).toBeGreaterThan(trigger)
  })

  test("code-mode 链:invokeChildTool 里 trigger 在 ask 与 callTool 之前", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/tool/code-mode.ts"), "utf8")
    const fn = body.indexOf("invokeChildTool = Effect.fn")
    expect(fn).toBeGreaterThanOrEqual(0)
    const { trigger, ask } = between(body, fn)
    const callTool = body.indexOf(".callTool(", fn)
    expect(trigger).toBeGreaterThan(fn)
    expect(ask).toBeGreaterThan(trigger)
    expect(callTool).toBeGreaterThan(ask)
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
  const def = JSON.stringify({
    type: "remote",
    url: "https://cloud.example/mcp",
    enabled: true,
    headers: { Authorization: `Bearer {file:${tokenFile}}` },
    oauth: false,
  })
  const armed = { [CLOUD_MCP_ARM_ENV]: "cloud", [CLOUD_MCP_DEF_ENV]: def }
  const readToken = () => "tok-live"

  test("装的是完整定义,且 {file:} 引用在这一层才被解析(config 钩子拿到的已是解析后对象)", () => {
    const cfg: { mcp?: Record<string, unknown> } = { mcp: { other: { type: "local", enabled: false } } }
    expect(installCloudMcp(cfg, armed, readToken)).toBe("cloud")
    expect(cfg.mcp!.cloud).toEqual({
      type: "remote",
      url: "https://cloud.example/mcp",
      enabled: true,
      headers: { Authorization: "Bearer tok-live" },
      oauth: false,
    })
    // 别人的 disabled 条目(账本覆盖 / XDG 默认拒绝)不归本握手管。
    expect(cfg.mcp!.other).toEqual({ type: "local", enabled: false })
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

  test("密钥文件读不到(登出 / 同步失败)⇒ 不装一个没有凭据的 server", () => {
    const cfg: { mcp?: Record<string, unknown> } = {}
    const missing = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    }
    expect(installCloudMcp(cfg, armed, missing)).toBeUndefined()
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

  const cloudDef = () => ({
    type: "remote",
    url: "https://cloud.example/mcp",
    enabled: true,
    headers: { Authorization: `Bearer {file:${tokenFile}}` },
    oauth: false,
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
    // {file:} 引用由 ext 自己解析(config 钩子拿到的是引擎已替换过的对象)。
    expect(cfg.mcp.cloud!.headers).toEqual({ Authorization: "Bearer tok-live" })
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
