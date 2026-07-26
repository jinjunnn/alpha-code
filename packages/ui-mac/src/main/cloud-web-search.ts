export const CLOUD_WEB_SEARCH_TOOL_ID = "cloud_web_search"
/** 引擎内置的本地 keyless web search 工具 ID(`packages/opencode/src/tool/websearch.ts`)。 */
export const LOCAL_WEB_SEARCH_TOOL_ID = "websearch"
/**
 * 主权判决送进 sidecar 的通道(#223 R2 Blocker 1)。permission 注入只能压平 **alpha 自己**注入的
 * agent,压不住别的 config 源后加载的 agent wildcard、持久化到 session 的 permission、或
 * `Permission.ask` 里排在 ruleset 之后的 `approved` —— 那三条都能把 deny 顶掉。最终闸因此落在
 * 工具自身:`packages/opencode/src/tool/websearch.ts` 读本变量直接拒绝执行。
 * 名字在两个包各写一份(ui-mac 不依赖 opencode),漂移由 `cloud-web-search.test.ts` 的字面量锁钉住。
 */
export const LOCAL_WEBSEARCH_DENY_ENV = "ALPHA_LOCAL_WEBSEARCH_DENY"
/**
 * 云侧同一条通道(#223 R3)。`cloud_web_search` 是**远端 MCP 工具**,没有 alpha 能改的
 * `execute` 首行可放闸,而 `ConfigMCPV1.Remote`(`packages/core/src/v1/config/mcp.ts`)只有
 * 整 server 的 `enabled`,**没有 per-tool 过滤** —— 「注册期就不提供这个工具」在引擎侧不存在。
 * 于是最终闸落在 alpha 自有的 ext 插件的 `tool.execute.before` 钩子
 * (`packages/ext/src/cloud-websearch-kill.ts`):普通 MCP(`session/tools.ts`)与 code-mode
 * (`tool/code-mode.ts`)两条路都在 `ctx.ask` **之前**触发它,钩子抛错即 die,
 * 因此 agent/session 的后置 allow 与 `approved` 一概够不着。
 */
export const CLOUD_WEBSEARCH_DENY_ENV = "ALPHA_CLOUD_WEBSEARCH_DENY"

/** 注入面给云 MCP server 起的名字(工具 id 由此拼成 `cloud_*`)。 */
export const CLOUD_MCP_SERVER_NAME = "cloud"

/**
 * ext 装载**握手**通道(#223 R4)。
 *
 * R3 的 fail-closed 判据是「`extPluginPath` 这个路径存不存在」——R4 证明那什么也证明不了:
 * `OPENCODE_PURE=true`(经 `sidecar-env.ts` 的 `OPENCODE_` 前缀规则进 sidecar,
 * `opencode/src/effect/runtime-flags.ts` 解释为 pure)会让 `opencode/src/plugin/index.ts` **整个
 * 跳过外部插件**;bundle import 失败与 `AlphaExt` 初始化失败同样是 log-and-continue。三种情形下
 * 路径都还在,钩子却根本不存在,云 `cloud_web_search` 于是带着一个可被后置 allow / approved
 * 顶掉的 permission deny 活着。
 *
 * 所以 kill-switch 下的注册改成**两段式**:注入面只写一个 `enabled:false` 的云 server 并把本变量
 * 置成 server 名;真正把它打开的是 `@alpha-code/ext` 自己的 `config` 钩子
 * (`packages/ext/src/cloud-websearch-kill.ts` 的 `armCloudMcp`)。那个钩子能跑 = 插件函数已返回
 * hooks 对象 = 同一个对象上的 `tool.execute.before` 闸确实注册了。ext 缺席则云 server 永远停在
 * disabled,一个活的 web_search 都出不去 —— 这才是「确认装载」,不是「路径存在」。
 *
 * 本变量由 sidecar 内的 `injectAlphaConfig` 自己置位/删除;它不在 `sidecar-env.ts` 的白名单里,
 * 因此外部 shell 伪造一个同名变量也进不来。
 */
export const CLOUD_MCP_ARM_ENV = "ALPHA_CLOUD_MCP_ARM"

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
 *   只支持整 server 开关,而整 server 关会误伤 `cloud_dispatch` 等兄弟工具。**这层同样只是
 *   可用性**(#223 R3):远端 MCP 工具最终走 `ctx.ask`,后置 allow / `approved` 都能顶掉它。
 *   云侧不可覆盖的最终闸在 `packages/ext/src/cloud-websearch-kill.ts` 的 `tool.execute.before`
 *   钩子,判决经 `CLOUD_WEBSEARCH_DENY_ENV` 过河。
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
 *
 * **本函数不是主权保证,只是可用性**(#223 R2 Blocker 1 裁决):它够不着别的 config 源后加载的
 * agent、够不着持久化到 session 的 permission、也够不着 `Permission.ask` 的 `approved`。它的作用
 * 是让被 deny 的工具从模型工具表里消失(`Permission.disabled`),免得模型看见一个必失败的工具。
 * 不可覆盖的最终规则在工具自身,由 `LOCAL_WEBSEARCH_DENY_ENV` 驱动(见上方注释)。
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

  config.permission = pinDeny({ ...config.permission }, denied)
  for (const agent of Object.values(config.agent ?? {})) {
    if (!agent) continue
    // #223 R2:以前只改**已有**的精确 `websearch` 键 —— 一个只写 `"*": "allow"` 的 agent 因此
    // 完全不被压平,而它的 wildcard 排在全局 deny 之后就赢。现在无条件写(并钉到末位)。
    agent.permission = pinDeny({ ...(agent.permission ?? {}) }, denied)
  }
}

/**
 * 把 deny 钉成表里的**最后一条**规则。`Permission.fromConfig` 按对象插入序展开、
 * `Permission.evaluate` 取 `findLast`,所以「只改值不动位置」不够:写在前面的
 * `websearch: "deny"` 会被同一张表里后面的 `"*": "allow"` 顶掉。删键再写回 = 移到末位。
 */
function pinDeny(permission: Record<string, unknown>, denied: string[]) {
  for (const id of denied) {
    delete permission[id]
    permission[id] = "deny"
  }
  return permission
}
