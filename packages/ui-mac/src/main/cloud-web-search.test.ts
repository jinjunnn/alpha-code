import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  applyWebSearchDenies,
  CLOUD_WEB_SEARCH_TOOL_ID,
  LOCAL_WEB_SEARCH_TOOL_ID,
  LOCAL_WEBSEARCH_DENY_ENV,
} from "./cloud-web-search"

const siblingCloudTools = [
  "cloud_dispatch",
  "cloud_status",
  "cloud_await",
  "cloud_artifacts",
  "cloud_schedule_create",
  "cloud_schedule_list",
  "cloud_schedule_delete",
] as const
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
