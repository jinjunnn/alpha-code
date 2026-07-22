import { describe, expect, test } from "bun:test"
import { applyCloudWebSearchDisable, CLOUD_WEB_SEARCH_TOOL_ID } from "./cloud-web-search"

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

describe("cloud websearch tool scoping", () => {
  test("disable removes only cloud_web_search while the cloud server and sibling tools remain live", () => {
    const diagnostics: string[] = []
    const config = {
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { [CLOUD_WEB_SEARCH_TOOL_ID]: "allow", bash: "allow" },
    }

    applyCloudWebSearchDisable(config, { ALPHA_WEBSEARCH_DISABLE: "1" }, (message) => diagnostics.push(message))

    expect(config.mcp.cloud.enabled).toBe(true)
    expect(registeredCloudTools.filter((tool) => config.permission[tool] === "deny")).toEqual([
      CLOUD_WEB_SEARCH_TOOL_ID,
    ])
    expect(config.permission).toEqual({ [CLOUD_WEB_SEARCH_TOOL_ID]: "deny", bash: "allow" })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain("remote MCP config has no per-tool deny")
  })

  test("unset leaves cloud tool registration and existing permissions unchanged", () => {
    const config = {
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { bash: "allow" },
    }

    const diagnostics: string[] = []
    applyCloudWebSearchDisable(config, {}, (message) => diagnostics.push(message))

    expect(config).toEqual({
      mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: true } },
      permission: { bash: "allow" },
    })
    expect(diagnostics).toEqual([])
  })
})
