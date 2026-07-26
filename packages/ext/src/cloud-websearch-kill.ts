// cloud-websearch-kill — ADR-009 的 web search 主权判决在 **MCP 工具**一侧的最终闸(#223 R3→R5)。
//
// 为什么闸只能落在这里(R3 判 B 属门控 Blocker 时的判据):
//
//   ① 云 `cloud_web_search` 是远端 MCP 工具,alpha 没有它的 `execute` 首行可放闸 —— 本地
//      `websearch` 的收口(工具自身读 `ALPHA_LOCAL_WEBSEARCH_DENY`)对它不适用。
//   ② 「注册期就不提供这个工具」在引擎侧**不存在**:`ConfigMCPV1.Remote`
//      (`packages/core/src/v1/config/mcp.ts`)只有整 server 的 `enabled`,没有 per-tool 过滤;
//      整 server 关会误伤 `cloud_dispatch` 等兄弟工具(AC4 禁止)。
//   ③ 注入面的 permission deny 只是**可用性**(把工具从模型工具表里滤掉),不是主权保证:
//      普通 MCP(`packages/opencode/src/session/tools.ts`)与 code-mode
//      (`packages/opencode/src/tool/code-mode.ts`)最终都走 `ctx.ask`,而 `Permission.ask` 的
//      `approved`、持久化到 session 的 permission、后加载的 agent wildcard 都排在注入的 deny
//      之后并赢 —— R2 对本地工具的动态探针已实测三条路径全变 allow。
//
// 这条路成立的机制事实(两条链在 R3 报告里都被点名):
//
//   session/tools.ts   → `plugin.trigger("tool.execute.before", ...)` **先于** `ctx.ask(...)`
//   tool/code-mode.ts  → `invokeChildTool` 里同样先 trigger 再 `ctx.ask(...)` 再 `callTool`
//
// 而 `Plugin.trigger`(`packages/opencode/src/plugin/index.ts`)对 hook 用的是
// `Effect.promise(async () => fn(input, output))` —— 未捕获,hook 抛出即 defect 上抛,工具调用
// 就此终止。钩子**不查任何 permission ruleset**,所以没有任何 permission 规则能覆盖它。
//
// ─────────────────────────────────────────────────────────────────────────────
// #223 R5 Blocker:命中面从「云 server 的那一个工具」扩到**每一个 MCP web search 工具**。
//
// R5 勘破的第三条出口不是假想的「自带新端点的副本」,是仓内**已支持**的通用路径:配置里直接
// 声明任意 Remote MCP,引擎经 `packages/opencode/src/mcp/index.ts` 建通用 MCP 传输,例如
//
//     { "mcp": { "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" } } }
//
// 会产生 `exa_web_search_exa` —— 它既不经 `McpWebSearch.call()`,也不经 Core 的 `callMcp()`,
// 那两道传输闸对它一概不成立;动态 `mcp.add` 同理。而**本钩子是这两条调用链的共同钳制点**:
// 普通模式与 code-mode 的每一次 MCP 工具执行都先过它。所以本地主权判决
// (`ALPHA_LOCAL_WEBSEARCH_DENY`)也接到同一个钩子上,判据按**工具形态**而不是 server 名。
//
// **产品语义(按「关」实现,归 owner 复核)**:主权态(平台代付或 kill-switch)下,连**用户自己
// 配置的** web-search MCP server 一起关。技术上这是唯一自洽的答案 —— 本地 keyless websearch 已
// 因「平台代付」被关,若用户加一个 exa remote MCP 就能拿回同一能力,那条主权判决等于不存在。
// 但这是产品取舍,不是纯技术结论,已在 ADR-009 登记并标「归 owner 复核」。
//
// 例外只有一个:alpha 自己注册的那个云 server(名字经 `ALPHA_CLOUD_MCP_SERVER` 过河)。平台代付
// 时它正是**权威**通道,只有 kill-switch(`ALPHA_CLOUD_WEBSEARCH_DENY`)才关它。
//
// 已知边界(不谎称穷尽):本闸只覆盖**引擎内**的 MCP / code-mode 工具执行 —— 它跑在 ext 装载
// 之后。ext 缺席时(见下方握手段)本闸不存在,那时能守住的只有「云 server 的定义根本不进配置」
// 与本地 websearch 工具自身的闸;一个用户自带的第三方 web-search MCP 在 ext 缺席时没有拦截点,
// 收口它需要收编 `session/tools.ts` / `code-mode.ts` 这类通用上游文件,不在本票范围。
// 本闸也不改变远端 MCP 目录本身(server 仍然会 advertise 这些工具),更够不着任何绕过 opencode
// 工具循环直接说 MCP 协议的客户端。
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs"

/** main 每次 fork 前落定的**云侧**主权判决通道(`ui-mac/src/main/cloud-web-search.ts` 同名同义)。 */
export const CLOUD_WEBSEARCH_DENY_ENV = "ALPHA_CLOUD_WEBSEARCH_DENY"

/**
 * 同一函数落定的**本地侧**判决通道(kill-switch **或**平台代付即置位)。名字在 core / opencode /
 * ui-mac / ext 四个包各写一份(彼此之间没有可共用的 alpha 依赖边)。
 */
export const LOCAL_WEBSEARCH_DENY_ENV = "ALPHA_LOCAL_WEBSEARCH_DENY"

/** fail-closed:除「缺省 / 空串 / `"0"`」外的任何取值都判为 deny。四个包里逐字同义。 */
function signalled(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name]
  return value !== undefined && value !== "" && value !== "0"
}

export function cloudWebSearchDenied(env: Record<string, string | undefined> = process.env): boolean {
  return signalled(env, CLOUD_WEBSEARCH_DENY_ENV)
}

export function localWebSearchDenied(env: Record<string, string | undefined> = process.env): boolean {
  return signalled(env, LOCAL_WEBSEARCH_DENY_ENV)
}

/**
 * 命中判据 = 工具 id 的**末段**正是一个 web search。
 *
 * MCP 工具 id 由 `McpCatalog.toolName` 拼成 `<server>_<tool>`,所以 alpha 注入的云 server
 * (`cloud`)上的 `web_search` 落地为 `cloud_web_search`,而用户自带的 exa remote MCP 落地为
 * `exa_web_search_exa`(前缀是 server 名、后缀是工具名自带的)。刻意不写死任何字面量:平台或
 * 第三方把工具改名成 `web_search_v2` 之类时闸不能哑掉。兄弟云工具(`cloud_dispatch` /
 * `cloud_status` / `cloud_await` / `cloud_artifacts` / `cloud_schedule_*`)一律不命中 ——
 * AC4 要求的「不误杀」。
 *
 * 边界:判据认的是 `web[_]search` 这个词根。一个把工具叫 `search_the_web` 或 `lookup` 的
 * server 不会被命中 —— 那属于「自带全新形态」,与传输层那两道闸的残留同类,不谎称穷尽。
 */
export function isWebSearchToolId(tool: string): boolean {
  return /(^|_)web_?search([_-][a-z0-9]+)*$/i.test(tool)
}

/** alpha 自己注册的云 MCP server 名(注入面经 `ALPHA_CLOUD_MCP_SERVER` 告知,见 ui-mac 同名常量)。 */
export const CLOUD_MCP_SERVER_ENV = "ALPHA_CLOUD_MCP_SERVER"

function isGovernedCloudTool(tool: string, env: Record<string, string | undefined>): boolean {
  const server = env[CLOUD_MCP_SERVER_ENV]
  return !!server && tool.startsWith(`${server}_`)
}

/**
 * 判决单个工具 id。返回模型可见的拒绝理由;`undefined` = 放行。
 *
 * - alpha 治理的云 server 上的 web search:只有 kill-switch 关它(代付态它是权威通道)。
 * - 其它任何 MCP server 上的 web search:主权态(本地 deny **或** kill-switch)一律关。
 *   kill-switch 会把两个信号都置位,这里对两个都判,是为了信号漂移时倒向 fail-closed。
 */
export function webSearchToolDenial(
  tool: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!isWebSearchToolId(tool)) return undefined
  if (isGovernedCloudTool(tool, env))
    return cloudWebSearchDenied(env) ? "the alpha web search kill switch (ADR-009 B2) is set" : undefined
  if (localWebSearchDenied(env) || cloudWebSearchDenied(env))
    return (
      "alpha web search sovereignty (ADR-009 B1/B2) denies every MCP web search tool except the platform's own " +
      "— the platform pays for search, or the web search kill switch is set"
    )
  return undefined
}

export class WebSearchSovereigntyError extends Error {
  constructor(tool: string, reason: string) {
    super(
      `${tool} is unavailable: ${reason}. ` +
        "This is not a transient failure and no permission grant can lift it; do not retry. " +
        "Answer without web search and say so.",
    )
    this.name = "WebSearchSovereigntyError"
  }
}

/** `tool.execute.before` 的首行。命中即抛 —— 抛出点早于 `ctx.ask`,故 approved/后置 allow 够不着。 */
export function assertWebSearchToolAllowed(tool: string, env: Record<string, string | undefined> = process.env): void {
  const reason = webSearchToolDenial(tool, env)
  if (reason) throw new WebSearchSovereigntyError(tool, reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// ext 装载握手(#223 R4,R5 收紧)。
//
// R3 的 fail-closed 判据是 main 侧「ext bundle 路径存不存在」。R4 给出三条路径仍在、钩子却不
// 存在的真实情形,每一条都让 kill-switch 下的 `cloud_web_search` 重新活过来:
//
//   ① `OPENCODE_PURE=true` —— 经 `ui-mac/src/main/sidecar-env.ts` 的 `OPENCODE_` 前缀规则进
//      sidecar,`opencode/src/effect/runtime-flags.ts` 解释为 pure,
//      `opencode/src/plugin/index.ts` 的 `flags.pure ? [] : (cfg.plugin_origins ?? [])`
//      于是**整个跳过**外部插件;
//   ② bundle import 失败 —— `PluginLoader.loadExternal` 的 report.error 只 publish 一条错误;
//   ③ `AlphaExt(input)` 初始化抛错 —— `Effect.tryPromise(...).pipe(Effect.catch(() => Effect.void))`,
//      log-and-continue。
//
// R4 的做法是注入面写一个 `enabled:false` 的云 server,由本模块把它翻开。**R5 判该形态是回归**:
// `MCP.connect()`(`opencode/src/mcp/index.ts`)**无条件**把配置复制成 `enabled:true`,该能力还
// 公开为 `/mcp/:name/connect`(`server/routes/instance/httpapi/handlers/mcp.ts`)且产品 UI 真的
// 在调 —— 于是 ext 缺席时,用户只要点一下就能把那份**含完整 URL 与 Authorization header** 的
// server 热连起来,而此时 `tool.execute.before` 闸并不存在。`enabled:false` 不是 disarmed,
// 它只是「本次初始化不连」。
//
// R5 形态:**kill-switch 下云 server 的完整定义根本不进配置**。注入面只把它经
// `ALPHA_CLOUD_MCP_DEF` 交给本模块(`ALPHA_CLOUD_MCP_ARM` 点名),由本函数在 `config` 钩子里
// 装进 `cfg.mcp`。`config` 钩子能跑 ⇒ 插件函数已返回 hooks 对象 ⇒ 同一对象上的
// `tool.execute.before` 闸确实注册了。三种缺席情形下本函数一次都不会被调用,配置里于是**没有
// 任何名为 cloud 的条目**:`/mcp/cloud/connect` 拿不到配置(`requireMcpConfig` → NotFound),
// 连兄弟云工具一起损失 —— 诚实的 fail-closed 降级。
//
// 仍够不着的一条(诚实登记):`POST /mcp` 的 `add` 要求调用方**自带**完整 server 定义,所以它
// 不是「复活已存在的定义」,而是新装一个 —— 拦它等于拦任意第三方 MCP,那要收编上游
// `handlers/mcp.ts` / `mcp/index.ts`,不在本票范围。ext 在场时它照样撞上面那道工具闸。
// ─────────────────────────────────────────────────────────────────────────────

/** 注入面告诉 ext「这个 MCP server 等你确认装载后才能装」的通道(ui-mac `cloud-web-search.ts` 同名同义)。 */
export const CLOUD_MCP_ARM_ENV = "ALPHA_CLOUD_MCP_ARM"

/** 与 ARM 配对的 server 定义(JSON)。内含 `{file:…}` 引用而非密钥值本身(A6 纪律)。 */
export const CLOUD_MCP_DEF_ENV = "ALPHA_CLOUD_MCP_DEF"

type McpHost = { mcp?: Record<string, unknown> }

/**
 * `{file:/abs/path}` 解析。引擎的 `ConfigVariable.substitute` 在**配置文本**阶段就把它换掉了,
 * 而 `config` 钩子拿到的是**已解析后的**对象 —— 本函数装进去的定义是钩子阶段新加的,不会再被
 * 替换,所以必须自己解析(语义与上游一致:读文件、trim)。读不到就抛,由调用方 fail-closed。
 */
function resolveFileRefs(value: unknown, readFile: (path: string) => string): unknown {
  if (typeof value === "string") return value.replace(/\{file:([^}]+)\}/g, (_, path: string) => readFile(path).trim())
  if (Array.isArray(value)) return value.map((item) => resolveFileRefs(item, readFile))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFileRefs(item, readFile)]))
  return value
}

/**
 * 把注入面托管的云 MCP server 定义装进配置。返回被装上的 server 名(没有可装的则 undefined)。
 *
 * 只在 ARM 与 DEF **同时**在场时动手 —— 两个都由 sidecar 内的 `injectAlphaConfig` 在每次 fork
 * 时置位或删除,外部伪造一个进不去(见 ui-mac `cloud-web-search.ts` 的通道说明)。
 */
export function installCloudMcp(
  cfg: unknown,
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  const name = env[CLOUD_MCP_ARM_ENV]
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!name || !raw) return undefined
  const host = cfg as McpHost | null | undefined
  if (!host || typeof host !== "object") return undefined

  let definition: unknown
  try {
    definition = JSON.parse(raw)
  } catch (error) {
    console.error(
      `[@alpha-code/ext] cloud MCP server "${name}" NOT installed: ${CLOUD_MCP_DEF_ENV} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
    return undefined
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    console.error(`[@alpha-code/ext] cloud MCP server "${name}" NOT installed: ${CLOUD_MCP_DEF_ENV} is not an object`)
    return undefined
  }

  let resolved: Record<string, unknown>
  try {
    resolved = resolveFileRefs(definition, readFile) as Record<string, unknown>
  } catch (error) {
    // 密钥文件读不到 = 已登出或密钥同步失败。装一个没有凭据的 server 只会以 401 收场,
    // fail-closed 直接不装(loud)。
    console.error(
      `[@alpha-code/ext] cloud MCP server "${name}" NOT installed: unresolved {file:} reference (${error instanceof Error ? error.message : String(error)})`,
    )
    return undefined
  }

  host.mcp = { ...(host.mcp ?? {}), [name]: { ...resolved, enabled: true } }
  return name
}
