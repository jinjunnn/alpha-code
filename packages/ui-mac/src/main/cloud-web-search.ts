export const CLOUD_WEB_SEARCH_TOOL_ID = "cloud_web_search"

type EngineConfig = {
  permission?: Record<string, unknown>
}

type WebSearchEnvironment = {
  ALPHA_WEBSEARCH_DISABLE?: string
}

export function applyCloudWebSearchDisable(
  config: EngineConfig,
  env: WebSearchEnvironment,
  diagnostic: (message: string) => void = console.error,
) {
  if (!env.ALPHA_WEBSEARCH_DISABLE) return

  // alpha-code#490: ConfigMCPV1.Remote only supports whole-server enable/disable. Keep the cloud
  // server connected and use the engine's model-tool permission filter so sibling tools survive.
  // TODO(alpha-code#490): replace this approximation with a remote-MCP per-tool deny when the engine
  // exposes one; until then the remote catalog still contains the tool even though model tool sets do not.
  diagnostic(
    "[alpha-code#490] remote MCP config has no per-tool deny; filtering cloud_web_search from model tool sets while preserving the cloud server and sibling tools",
  )
  config.permission = {
    ...config.permission,
    [CLOUD_WEB_SEARCH_TOOL_ID]: "deny",
  }
}
