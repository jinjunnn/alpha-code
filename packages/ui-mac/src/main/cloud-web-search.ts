export const CLOUD_WEB_SEARCH_TOOL_ID = "cloud_web_search"
/** 引擎内置的本地 keyless web search 工具 ID(`packages/opencode/src/tool/websearch.ts`)。 */
export const LOCAL_WEB_SEARCH_TOOL_ID = "websearch"

type AgentConfig = { permission?: Record<string, unknown> }

type EngineConfig = {
  permission?: Record<string, unknown>
  agent?: Record<string, AgentConfig | undefined>
}

/** ADR-009 B1/B2 的两个主权判据,由 `injectAlphaConfig` 从 sidecar 自己的 env/密钥文件推导。 */
export type WebSearchSovereignty = {
  /** `ALPHA_WEBSEARCH_DISABLE`:与登录态无关的能力总闸(B2)。 */
  killSwitch: boolean
  /** 平台代付(`ALPHA_CLOUD_MCP_URL` + `ALPHA_CLOUD_TOKEN` 密钥文件同在):云工具权威(B1)。 */
  platformPays: boolean
}

/**
 * 把 ADR-009 的 web search 主权判决落到引擎 permission 层。
 *
 * - **云 `cloud_web_search`**:仅 kill-switch 时 deny(alpha-code#490)。`ConfigMCPV1.Remote`
 *   只支持整 server 开关,而整 server 关会误伤 `cloud_dispatch` 等兄弟工具。
 * - **本地 `websearch`**:kill-switch **或**平台代付时 deny。#223 对抗审计(2026-07-25)动态
 *   复现:env 层的 4 个 keyless flag force-off **压不住** umbrella —— 上游
 *   `runtime-flags.ts` 的 `enableExa = OPENCODE_EXPERIMENTAL || OPENCODE_ENABLE_EXA ||
 *   OPENCODE_EXPERIMENTAL_EXA`,用户 `export OPENCODE_EXPERIMENTAL=1` 后闸把四个专用 flag
 *   写 `"0"` 也恒真,`webSearchEnabled()` 继续注册本地 `websearch`(登录态本地+云双活;
 *   kill-switch 下云暗而本地仍活)。收口走 ADR-009 裁决 (b) 的路 (i):**对本地工具 ID 也走
 *   permission deny**,零改上游 registry、不碰 umbrella(它是 references / code-mode 等
 *   全部实验能力的总开关,盲目 force-0 违反「一开关一具名能力」)。
 *
 * agent 级 permission 在引擎里排在全局规则**之后**(`agent/agent.ts`:自定义 agent 走
 * `merge(item.permission, fromConfig(value.permission))`,`Permission.evaluate` 取
 * `findLast`),所以 alpha 自己注入的三个 agent 里的 `websearch: "allow"` 会把全局 deny 顶掉
 * —— 必须一并压平,否则闸只对 build/plan 之类原生 agent 成立。
 */
export function applyWebSearchDenies(
  config: EngineConfig,
  state: WebSearchSovereignty,
  diagnostic: (message: string) => void = console.error,
) {
  const denied: string[] = []
  if (state.killSwitch) denied.push(CLOUD_WEB_SEARCH_TOOL_ID)
  if (state.killSwitch || state.platformPays) denied.push(LOCAL_WEB_SEARCH_TOOL_ID)
  if (denied.length === 0) return

  if (denied.includes(CLOUD_WEB_SEARCH_TOOL_ID))
    // alpha-code#490: ConfigMCPV1.Remote only supports whole-server enable/disable. Keep the cloud
    // server connected and use the engine's model-tool permission filter so sibling tools survive.
    // TODO(alpha-code#490): replace this approximation with a remote-MCP per-tool deny when the engine
    // exposes one; until then the remote catalog still contains the tool even though model tool sets do not.
    diagnostic(
      "[alpha-code#490] remote MCP config has no per-tool deny; filtering cloud_web_search from model tool sets while preserving the cloud server and sibling tools",
    )
  if (denied.includes(LOCAL_WEB_SEARCH_TOOL_ID))
    diagnostic(
      `[alpha-code#223] denying the local ${LOCAL_WEB_SEARCH_TOOL_ID} tool (${state.killSwitch ? "kill switch" : "platform pays"}) — the four keyless env flags cannot suppress it under OPENCODE_EXPERIMENTAL=1`,
    )

  config.permission = { ...config.permission, ...Object.fromEntries(denied.map((id) => [id, "deny"])) }
  for (const agent of Object.values(config.agent ?? {})) {
    if (!agent?.permission) continue
    for (const id of denied) if (id in agent.permission) agent.permission[id] = "deny"
  }
}
