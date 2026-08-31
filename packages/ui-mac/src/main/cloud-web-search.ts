/** 注入面给云 MCP server 起的名字。工具 id 由它与远端工具名拼成(见 `cloudMcpToolId`)。 */
export const CLOUD_MCP_SERVER_NAME = "cloud"

/**
 * 已部署云 worker **自己** advertise 的远端工具名(#643 P1.3 实测 `remoteToolNames` 含
 * `cloud_web_search`)。**它不是引擎里的工具 id** —— 远端名自带 `cloud_` 前缀纯属命名巧合,
 * 引擎还会再拼一次 server 名。混淆这两层正是 #650 的缺陷。
 */
export const CLOUD_WEB_SEARCH_REMOTE_TOOL = "cloud_web_search"

/** `McpCatalog.sanitize`(`packages/opencode/src/mcp/catalog.ts:117`)逐字同义。 */
const sanitizeMcpName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * 引擎给远端 MCP 工具起的 id,`McpCatalog.toolName`(同文件 `:119`)逐字同义:
 * `sanitize(server) + "_" + sanitize(remote)`。ui-mac 不依赖 opencode,所以拼法在这里再写一份;
 * 漂移由 `cloud-web-search.test.ts` 用**真的** `McpCatalog.toolName` 钉住,不是靠字面量对照。
 */
export const cloudMcpToolId = (remoteName: string) =>
  `${sanitizeMcpName(CLOUD_MCP_SERVER_NAME)}_${sanitizeMcpName(remoteName)}`

/**
 * 云 web search 在**引擎**里的真实工具 id = `cloud_cloud_web_search`(#643 P2.1 实测
 * `calledTool`)。
 *
 * **#650**:这里以前写的是远端名 `cloud_web_search`。它经 `Permission.fromConfig` →
 * `Permission.disabled` → `Wildcard.match` 编成 `^cloud_web_search$`,对真实 id 恒不匹配 ——
 * kill-switch 下那道 permission deny 是**空闸门**,云工具从未从模型工具表里消失过。
 */
export const CLOUD_WEB_SEARCH_TOOL_ID = cloudMcpToolId(CLOUD_WEB_SEARCH_REMOTE_TOOL)
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
 * 云侧同一条通道(#223 R3)。云 web search(引擎 id `cloud_cloud_web_search`)是**远端 MCP 工具**,没有 alpha 能改的
 * `execute` 首行可放闸,而 `ConfigMCPV1.Remote`(`packages/core/src/v1/config/mcp.ts`)只有
 * 整 server 的 `enabled`,**没有 per-tool 过滤** —— 「注册期就不提供这个工具」在引擎侧不存在。
 * 于是最终闸落在 alpha 自有的 ext 插件的 `tool.execute.before` 钩子
 * (`packages/ext/src/cloud-websearch-kill.ts`):普通 MCP(`session/tools.ts`)与 code-mode
 * (`tool/code-mode.ts`)两条路都在 `ctx.ask` **之前**触发它,钩子抛错即 die,
 * 因此 agent/session 的后置 allow 与 `approved` 一概够不着。
 */
export const CLOUD_WEBSEARCH_DENY_ENV = "ALPHA_CLOUD_WEBSEARCH_DENY"

/**
 * kill-switch 下写进 `OPENCODE_CONFIG_CONTENT` 的**中和条目**(#223 R6 Major)。
 *
 * R5 只从继承来的 `OPENCODE_CONFIG_CONTENT` 对象里删掉 `mcp.cloud`,并据此声称「继承来的同名
 * 条目一并抹掉」。R6 判该声称**不成立**:引擎还分别加载 XDG global、`OPENCODE_CONFIG`
 * (alpha.jsonc)、项目目录与 managed 配置(`opencode/src/config/config.ts`),而深合并里
 * 「缺少 cloud 键」**不会删除**先前来源的定义。于是那些来源里的一份完整 `cloud` 定义仍会自动
 * 连接;写成 `enabled:false` 也没用 —— `MCP.connect()` 无条件复制成 `enabled:true`。
 *
 * 能压过先前来源的只有**覆盖连接控制字段**:`OPENCODE_CONFIG_CONTENT` 排在 global / `OPENCODE_CONFIG` /
 * 项目 / `.opencode` 与 `OPENCODE_CONFIG_DIR` 目录**之后**,`type` 与 `url` 是标量,later-wins。
 * **不是逐字段完整覆盖(#223 R7 措辞更正)**:真实 `mergeDeep` 探针显示继承来的 `headers` / `timeout`
 * 会留下(`oauth` 子对象则被 `false` 整体替换)。它们无害 —— `url` 已经换成不可用的 loopback,那些
 * 头一个字节也发不出去 —— 但宣称只能写「覆盖连接控制字段」,不能写成逐字段完整覆盖。
 * URL 指向 `127.0.0.1:1`:**不做 DNS**、必然 ECONNREFUSED(端口 1 在类 Unix 上要 root 才能 bind),
 * 于是即便有人经 `/mcp/cloud/connect` 强行翻开,TCP 握手就失败、一个字节都发不出去 —— 继承来的
 * Authorization 头也就不会去到任何地方。
 * ext 确认装载后由 `installCloudMcp()` 整条替换它(`packages/ext/src/cloud-websearch-kill.ts`)。
 *
 * **覆盖不到的两个来源(诚实登记)**:managed 目录与 macOS MDM 托管偏好排在
 * `OPENCODE_CONFIG_CONTENT` 之后,能覆盖回去 —— 两者都需要 root/管理员,不在用户威胁模型内。
 * 事实由 `packages/opencode/test/mcp/alpha-cloud-mcp-multisource.test.ts` 用真实多源加载钉住。
 */
export const WITHHELD_CLOUD_MCP = {
  type: "remote" as const,
  url: "http://127.0.0.1:1/alpha-cloud-withheld",
  enabled: false as const,
  oauth: false as const,
}

/**
 * 告诉 ext「哪个 MCP server 是 alpha 治理的云通道」(#223 R5)。
 *
 * ext 的 `tool.execute.before` 闸现在对**任何** MCP server 上的 web search 形态生效(用户自带的
 * `exa_web_search_exa` 也在内,见 `packages/ext/src/cloud-websearch-kill.ts` 的 R5 段)。唯一的
 * 例外是这个 server:平台代付时它是**权威**通道,只有 kill-switch 才关它。ext 靠本变量识别它,
 * 而不是写死 `"cloud"` 字面量。注入面在每次 fork 注册云 server 时置位、否则删除。
 */
export const CLOUD_MCP_SERVER_ENV = "ALPHA_CLOUD_MCP_SERVER"

/**
 * ext 装载**握手**通道(#223 R4,R5 收紧)。
 *
 * R3 的 fail-closed 判据是「`extPluginPath` 这个路径存不存在」——R4 证明那什么也证明不了:
 * `OPENCODE_PURE=true`(经 `sidecar-env.ts` 的 `OPENCODE_` 前缀规则进 sidecar,
 * `opencode/src/effect/runtime-flags.ts` 解释为 pure)会让 `opencode/src/plugin/index.ts` **整个
 * 跳过外部插件**;bundle import 失败与 `AlphaExt` 初始化失败同样是 log-and-continue。三种情形下
 * 路径都还在,钩子却根本不存在。
 *
 * R4 据此把 kill-switch 下的注册改成两段式:注入面写一个 `enabled:false` 的云 server,由 ext 的
 * `config` 钩子翻开。**R5 判该形态是回归**:`MCP.connect()`(`opencode/src/mcp/index.ts`)会
 * **无条件**把配置复制成 `enabled:true`,而该能力公开为 `/mcp/:name/connect`
 * (`server/routes/instance/httpapi/handlers/mcp.ts`)且产品 UI 真的在调 —— ext 缺席时用户点一下
 * 就能把那份含完整 URL 与 Authorization header 的定义热连起来,此时闸并不存在。
 *
 * 所以 R5 起:**kill-switch 下完整定义根本不进 `OPENCODE_CONFIG_CONTENT`**。注入面把它经
 * `CLOUD_MCP_DEF_ENV` 交给 ext(本变量点名),由 `installCloudMcp()` 在 `config` 钩子里装进配置。
 * 那个钩子能跑 = 插件函数已返回 hooks 对象 = 同一个对象上的 `tool.execute.before` 闸确实注册了。
 * ext 缺席则配置里**没有**名为 `cloud` 的条目,`/connect` 直接 NotFound —— 这才是「确认装载」。
 *
 * **通道可信度的准确表述(#223 R5 Minor,更正 R4 的「shell 进不来」)**:本变量确实不在
 * `sidecar-env.ts` 的固定白名单里,但那份白名单有一个逃生阀 `ALPHA_ENV_ALLOWLIST_EXTRA`,
 * 用它点名即可放行任意非密钥名 —— 所以「外部 shell 伪造进不来」**不成立**。真正成立的是:
 * `injectAlphaConfig` 在每次 fork 的每一条分支上都**覆盖或删除**本变量与 `CLOUD_MCP_DEF_ENV`,
 * 因此继承来的值一律不作数;而且单有 ARM 没有 DEF 时 ext 什么也不装。
 */
export const CLOUD_MCP_ARM_ENV = "ALPHA_CLOUD_MCP_ARM"

/**
 * 与 ARM 配对的云 server 定义(JSON)。内容是 `materializeCloudMcpConfig()` 的产物。
 *
 * `#733` 起这份定义里**一个凭证通道都没有** —— 没有 `headers.Authorization`,也就没有
 * `{file:…}` 引用要托管(从前那句「Authorization 头里是 `{file:}` 引用而不是 token 值本身」
 * 描述的是静态 bearer 时代)。A6「密钥不进 env」因此从"引用而非明文"升级成"根本没有密钥":
 * 云 MCP 的凭证由引擎自己的 OAuth 凭证库持有,从不经过这条 env 通道。
 * ext 侧仍由 `installCloudMcp()` 把它装进配置。
 */
export const CLOUD_MCP_DEF_ENV = "ALPHA_CLOUD_MCP_DEF"

type AgentConfig = { permission?: Record<string, unknown> }

type EngineConfig = {
  permission?: Record<string, unknown>
  agent?: Record<string, AgentConfig | undefined>
}

/** ADR-009 B1/B2 的两个主权判据,由 `injectAlphaConfig` 从 sidecar 自己的 env/密钥文件推导。 */
export type WebSearchSovereignty = {
  /** `ALPHA_WEBSEARCH_DISABLE`:与登录态无关的能力总闸(B2)。 */
  killSwitch: boolean
  /** 平台代付(`ALPHA_CLOUD_MCP_URL` + `ALPHA_MCP_TOKEN` 密钥文件同在,`#1195` 换轴):云工具权威(B1)。 */
  platformPays: boolean
}

/**
 * 把 ADR-009 的 web search 主权判决落到引擎 permission 层。
 *
 * - **云 web search(`CLOUD_WEB_SEARCH_TOOL_ID` = `cloud_cloud_web_search`)**:仅 kill-switch 时 deny(alpha-code#490)。`ConfigMCPV1.Remote`
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
      `[alpha-code#490] remote MCP config has no per-tool deny; filtering ${CLOUD_WEB_SEARCH_TOOL_ID} from model tool sets while preserving the cloud server and sibling tools`,
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
