import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
// #650:工具 id 一律从**引擎自己的**拼名规则推导。手喂字面量正是让这道闸空了整整一个需求的原因,
// 所以这里装的是真的 `McpCatalog` 与真的 `Permission`,不是替身。
import { McpCatalog } from "../../../opencode/src/mcp/catalog"
import { Permission } from "../../../opencode/src/permission/index"
import {
  applyWebSearchDenies,
  CLOUD_MCP_SERVER_NAME,
  CLOUD_WEB_SEARCH_REMOTE_TOOL,
  CLOUD_WEB_SEARCH_TOOL_ID,
  LOCAL_WEB_SEARCH_TOOL_ID,
  LOCAL_WEBSEARCH_DENY_ENV,
} from "./cloud-web-search"

/** 云 worker **自己** advertise 的远端工具名(#643 P1.3 实测 `remoteToolNames`)。 */
const siblingRemoteTools = [
  "cloud_dispatch",
  "cloud_status",
  "cloud_await",
  "cloud_artifacts",
  "cloud_schedule_create",
  "cloud_schedule_list",
  "cloud_schedule_delete",
] as const
/** 远端名 → 引擎 id,走引擎自己的 `McpCatalog.toolName`(#650:不得手写第二份)。 */
const engineToolId = (remoteName: string) => McpCatalog.toolName(CLOUD_MCP_SERVER_NAME, remoteName)
const siblingCloudTools = siblingRemoteTools.map(engineToolId)
const registeredCloudTools = [CLOUD_WEB_SEARCH_TOOL_ID, ...siblingCloudTools]

/** alpha 注入的三个 agent 都显式 `websearch: "allow"`(alpha-config-injection.ts)。 */
const alphaAgents = () => ({
  "alpha-automation": { permission: { websearch: "allow", bash: "deny" } },
  "alpha-readonly": { permission: { websearch: "allow", edit: "deny" } },
  "alpha-automation-standard": { permission: { websearch: "allow", edit: "allow" } },
})

describe("web search sovereignty denies", () => {
  test("kill switch removes both web search tools while the cloud server and sibling tools remain live", () => {
    const diagnostics: string[] = []
    const config = {
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { [CLOUD_WEB_SEARCH_TOOL_ID]: "allow", bash: "allow" },
      agent: alphaAgents(),
    }

    applyWebSearchDenies(config, { killSwitch: true, platformPays: false }, (message) => diagnostics.push(message))

    expect(config.mcp.cloud.enabled).toBe(true)
    expect(registeredCloudTools.filter((tool) => config.permission[tool] === "deny")).toEqual([
      CLOUD_WEB_SEARCH_TOOL_ID,
    ])
    expect(config.permission).toEqual({
      [CLOUD_WEB_SEARCH_TOOL_ID]: "deny",
      [LOCAL_WEB_SEARCH_TOOL_ID]: "deny",
      bash: "allow",
    })
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics.join("\n")).toContain("remote MCP config has no per-tool deny")
  })

  // #223 Blocker:env 层的四个 keyless flag force-off 压不住 `OPENCODE_EXPERIMENTAL` umbrella,
  // 代付态下本地 `websearch` 与 `cloud_web_search` 双活。收口靠这条 deny。
  test("platform pays denies the local websearch tool and leaves the cloud tool authoritative", () => {
    const config = {
      permission: { bash: "allow" },
      agent: alphaAgents(),
    }

    applyWebSearchDenies(config, { killSwitch: false, platformPays: true }, () => {})

    expect(config.permission).toEqual({ [LOCAL_WEB_SEARCH_TOOL_ID]: "deny", bash: "allow" })
    expect(config.permission[CLOUD_WEB_SEARCH_TOOL_ID]).toBeUndefined()
  })

  // agent 级规则在引擎里排在全局规则**之后**(agent/agent.ts 的 merge 序 + evaluate 的 findLast),
  // 所以不压平这三个 agent 的话,全局 deny 对它们无效 —— 闸只对 build/plan 之类原生 agent 成立。
  test("no injected agent may re-allow a denied web search tool", () => {
    for (const state of [
      { killSwitch: true, platformPays: false },
      { killSwitch: false, platformPays: true },
      { killSwitch: true, platformPays: true },
    ]) {
      const config = { permission: {}, agent: alphaAgents() }
      applyWebSearchDenies(config, state, () => {})
      for (const agent of Object.values(config.agent)) {
        expect(agent.permission[LOCAL_WEB_SEARCH_TOOL_ID]).toBe("deny")
        expect(agent.permission[CLOUD_WEB_SEARCH_TOOL_ID]).not.toBe("allow")
      }
    }
  })

  test("agent rules unrelated to web search stay untouched", () => {
    const config = { permission: {}, agent: alphaAgents() }
    applyWebSearchDenies(config, { killSwitch: true, platformPays: true }, () => {})
    expect(config.agent["alpha-automation-standard"].permission.edit).toBe("allow")
    expect(config.agent["alpha-readonly"].permission.edit).toBe("deny")
  })

  // #223 R2 Blocker 1(路径 ①):`applyWebSearchDenies` 以前只改**已有的精确** `websearch` 键 ——
  // 一个只写 `"*": "allow"` 的 agent 完全不被压平,而它的 wildcard 排在全局 deny 之后就赢
  // (`Permission.fromConfig` 按插入序展开 + `evaluate` 取 `findLast`)。同一张表里的顺序也算数,
  // 所以 deny 必须被钉到**末位**,不能只改值。
  test("an agent wildcard cannot re-allow a denied web search tool", () => {
    const config = {
      permission: { [LOCAL_WEB_SEARCH_TOOL_ID]: "allow", "*": "allow" },
      agent: {
        "wildcard-only": { permission: { "*": "allow" } },
        "wildcard-after-deny": { permission: { [LOCAL_WEB_SEARCH_TOOL_ID]: "allow", "*": "allow" } },
        "no-permission-block": {},
      },
    }

    applyWebSearchDenies(config, { killSwitch: false, platformPays: true }, () => {})

    const lastRuleWins = (permission: Record<string, unknown>) => {
      // 引擎语义的最小复刻:精确键与 `"*"` 都能匹配 `websearch`,取最后一条。
      const matching = Object.keys(permission).filter((key) => key === LOCAL_WEB_SEARCH_TOOL_ID || key === "*")
      return permission[matching[matching.length - 1]!]
    }

    expect(lastRuleWins(config.permission)).toBe("deny")
    for (const agent of Object.values(config.agent) as { permission?: Record<string, unknown> }[]) {
      expect(agent.permission?.[LOCAL_WEB_SEARCH_TOOL_ID]).toBe("deny")
      expect(lastRuleWins(agent.permission!)).toBe("deny")
    }
  })

  // 注入面够不着的三条绕过(别的 config 源后加载的 agent / 持久 session permission / approved)
  // 由工具自身的最终闸兜底,判决靠这个 env 变量过河。两个包各写一份字面量 —— 这里钉住不许漂移。
  test("the sovereignty env channel name matches the engine-side reader", () => {
    expect(LOCAL_WEBSEARCH_DENY_ENV).toBe("ALPHA_LOCAL_WEBSEARCH_DENY")
    // #223 R4:声明点下沉到 `mcp-websearch.ts`(本引擎唯一的出网出口),叶子只转出。
    const transport = readFileSync(join(import.meta.dir, "../../../opencode/src/tool/mcp-websearch.ts"), "utf8")
    expect(transport).toContain(`export const LOCAL_WEBSEARCH_DENY_ENV = "${LOCAL_WEBSEARCH_DENY_ENV}"`)
    expect(transport).toContain("if (localWebSearchDenied())")
    const leaf = readFileSync(join(import.meta.dir, "../../../opencode/src/tool/websearch.ts"), "utf8")
    expect(leaf).toContain("export const LOCAL_WEBSEARCH_DENY_ENV = McpWebSearch.LOCAL_WEBSEARCH_DENY_ENV")
    expect(leaf).toContain("if (localWebSearchDenied())")
  })

  test("logged-out/BYOK leaves cloud tool registration and existing permissions unchanged", () => {
    const config = {
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { bash: "allow" },
      agent: alphaAgents(),
    }

    const diagnostics: string[] = []
    applyWebSearchDenies(config, { killSwitch: false, platformPays: false }, (message) => diagnostics.push(message))

    expect(config).toEqual({
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { bash: "allow" },
      agent: alphaAgents(),
    })
    expect(diagnostics).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #650 —— 这道 permission deny 曾是**空闸门**,而上面每一条用例都全绿。
//
// 原因不是逻辑写错,是**数据模型错**:注入面把「远端 server 自己 advertise 的工具名」当成了
// 「引擎里的工具 id」。引擎按 `McpCatalog.toolName(server, remote)` 拼名,而云 worker 的远端名
// 本身就叫 `cloud_web_search`,拼上 server 名 `cloud` 之后真实 id 是 `cloud_cloud_web_search`
// (#643 P2.1 实测 `calledTool`)。写进 config 的 `cloud_web_search` 经 `Wildcard.match` 编成
// `^cloud_web_search$`,对真实 id 恒不匹配 —— kill-switch 下云工具从来没有从模型工具表里消失过。
//
// 上面那些用例抓不到它,是因为它们**手喂** id:两边喂同一个错值,断言自然成立。所以本组的
// 纪律是两条:
//   ① id 只从**引擎自己的** `McpCatalog.toolName` 推导(改 server 名或远端名 ⇒ 期望值跟着变);
//   ② 判据是**引擎自己的** `Permission.fromConfig` + `Permission.disabled` 的返回值,
//      不是「config 里那个键等于某字符串」—— 后者正是当初全绿的那种断言。
// ─────────────────────────────────────────────────────────────────────────────
describe("#650 云 web search 闸按引擎真实 id 命中", () => {
  test("生产常量 = 引擎的拼名规则算出来的 id,而不是远端工具名", () => {
    expect(CLOUD_WEB_SEARCH_TOOL_ID).toBe(McpCatalog.toolName(CLOUD_MCP_SERVER_NAME, CLOUD_WEB_SEARCH_REMOTE_TOOL))
    // 远端名自带 `cloud_` 前缀,两者长得几乎一样 —— 正是这一点让缺陷活了一个需求。
    expect(CLOUD_WEB_SEARCH_TOOL_ID).not.toBe(CLOUD_WEB_SEARCH_REMOTE_TOOL)
  })

  // 远端工具名的**真源**是已部署的 worker,不是这个仓里的任何一处字面量。#643 的真机探针把
  // 「worker advertise 的名字」与「引擎据此算出的 id」都写进了取证产物 —— 拿它当锚,平台改名
  // 而这里没跟上时,下一次取证跑完就红。锚缺失也判红:没有真源 = 这两个常量无人担保。
  test("远端名与引擎 id 与最近一次真机取证一致(#643)", () => {
    const evidence = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../docs/verification/2026-07-27-e7-packaged-live/results/latest-logged-in.json"),
        "utf8",
      ),
    ) as { schema?: string; phase?: string; remoteWebSearchToolName?: string; derivedEngineToolId?: string }
    expect([evidence.schema, evidence.phase]).toEqual(["alpha-code/e7-packaged-live/v1", "logged-in"])
    expect(evidence.remoteWebSearchToolName).toBe(CLOUD_WEB_SEARCH_REMOTE_TOOL)
    expect(evidence.derivedEngineToolId).toBe(CLOUD_WEB_SEARCH_TOOL_ID)
  })

  /**
   * 引擎**真正注册**的云工具 id。刻意**不**取 `CLOUD_WEB_SEARCH_TOOL_ID` —— 那是被测方写的值,
   * 拿它当期望值就等于让判据跟着缺陷一起动(变异实测:那样写时把生产常量改回远端名,下面两条
   * 行为断言仍然全绿)。这里一律走引擎自己的 `McpCatalog.toolName`,再加两个非云对照。
   */
  const registeredTools = () => [
    ...[CLOUD_WEB_SEARCH_REMOTE_TOOL, ...siblingRemoteTools].map(engineToolId),
    LOCAL_WEB_SEARCH_TOOL_ID,
    "bash",
  ]
  /** 期望被隐藏的那个 id,同样从远端名推导。 */
  const cloudWebSearchEngineId = () => engineToolId(CLOUD_WEB_SEARCH_REMOTE_TOOL)

  test("kill-switch:引擎真的把云 web search 滤出模型工具表,兄弟云工具一个不少", () => {
    const config: { permission: Record<string, unknown>; agent: ReturnType<typeof alphaAgents> } = {
      permission: { bash: "allow" },
      agent: alphaAgents(),
    }
    applyWebSearchDenies(config, { killSwitch: true, platformPays: false }, () => {})

    // 判据 = 引擎自己算出来的隐藏集(`session/tools.ts` 经 `Permission.visibleTools` 消费同一个函数)。
    const hidden = Permission.disabled(registeredTools(), Permission.fromConfig(config.permission as never))
    expect([...hidden].sort()).toEqual([cloudWebSearchEngineId(), LOCAL_WEB_SEARCH_TOOL_ID].sort())
  })

  test("kill-switch:alpha 注入的 agent 也压得住(agent 规则排在全局之后,取 findLast)", () => {
    const config: { permission: Record<string, unknown>; agent: ReturnType<typeof alphaAgents> } = {
      permission: {},
      agent: alphaAgents(),
    }
    applyWebSearchDenies(config, { killSwitch: true, platformPays: false }, () => {})

    for (const [name, agent] of Object.entries(config.agent)) {
      // `agent/agent.ts`:自定义 agent 的规则接在全局之后,`evaluate`/`disabled` 都取 findLast。
      const ruleset = Permission.merge(
        Permission.fromConfig(config.permission as never),
        Permission.fromConfig(agent.permission as never),
      )
      const hidden = Permission.disabled(registeredTools(), ruleset)
      expect([name, hidden.has(cloudWebSearchEngineId())]).toEqual([name, true])
      expect([name, hidden.has(McpCatalog.toolName(CLOUD_MCP_SERVER_NAME, "cloud_dispatch"))]).toEqual([name, false])
    }
  })

  test("代付但无 kill-switch:云工具是权威通道,引擎不许把它藏起来", () => {
    const config: { permission: Record<string, unknown>; agent: ReturnType<typeof alphaAgents> } = {
      permission: {},
      agent: alphaAgents(),
    }
    applyWebSearchDenies(config, { killSwitch: false, platformPays: true }, () => {})

    const hidden = Permission.disabled(registeredTools(), Permission.fromConfig(config.permission as never))
    expect([...hidden]).toEqual([LOCAL_WEB_SEARCH_TOOL_ID])
  })

  // 模型看得见的那句话里点名的工具必须真的存在,否则拒绝文案本身就是错误指路。
  // 两个包都不依赖 ui-mac,只能靠这条锁 —— 但锁的**期望值是推导出来的**,不是第二份字面量。
  test("两份拒绝文案指向的是引擎真实 id", () => {
    for (const path of ["../../../opencode/src/tool/mcp-websearch.ts", "../../../core/src/tool/websearch.ts"]) {
      const body = readFileSync(join(import.meta.dir, path), "utf8")
      expect([path, body.includes(`Use ${CLOUD_WEB_SEARCH_TOOL_ID} if it is present`)]).toEqual([path, true])
      // 远端名单独出现 = 有人把 id 写回了远端名。
      expect([path, body.includes(`Use ${CLOUD_WEB_SEARCH_REMOTE_TOOL} if it is present`)]).toEqual([path, false])
    }
  })
})
