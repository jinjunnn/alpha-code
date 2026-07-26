import { describe, expect, test } from "bun:test"
import { applyWebSearchDenies, CLOUD_WEB_SEARCH_TOOL_ID, LOCAL_WEB_SEARCH_TOOL_ID } from "./cloud-web-search"

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
