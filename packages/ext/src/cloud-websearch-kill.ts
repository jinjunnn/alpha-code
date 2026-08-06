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
// **产品语义(按「关」实现,归 owner 复核)**:主权态(平台代付或 kill-switch)下,对用户自己
// 配置的 web-search MCP server 也**尽力**关。技术上这是唯一自洽的方向 —— 本地 keyless websearch
// 已因「平台代付」被关,若用户加一个 exa remote MCP 就能拿回同一能力,那条主权判决就被架空。
// 但这是产品取舍,不是纯技术结论,已在 ADR-009 登记并标「归 owner 复核」。
//
// ─────────────────────────────────────────────────────────────────────────────
// #223 R6 Blocker:分类是**尽力而为**,例外必须是**不可伪造**的。
//
// R6 对 R5 那版给出两条实跑证据:
//
//   ① 分类漏。判据只认 `web_search` 词根,合法工具名 `search_web` / `web-search` /
//      `websearchTool` / `brave-search` 全部 `denial:null`;更根本地,非 ASCII 工具名经
//      `McpCatalog.sanitize`(`opencode/src/mcp/catalog.ts`)后只剩下划线,**任何**按名字的
//      分类器都看不见它。按名字识别第三方 web search **做不到穷尽**,这是判据形态本身的天花板。
//   ② 例外可伪造。R5 的例外是 `tool.startsWith("${server}_")` —— 那不是 server **身份**,是
//      名字前缀。于是用户声明一个叫 `cloud_attacker` 的 server,`cloud_attacker_web_search`
//      就被当成 alpha 治理的云工具直接放行;一个叫 `cloud_web` 的 server 上的 `search` 同理。
//
// 本轮据此把两件事分开,并按 R6 的裁决收窄宣称:
//
//   **分类(`isWebSearchToolId`)= 尽力而为的启发式,不谎称穷尽。** 词根之外补了「`search` 与
//   web/internet/online 或一个具名搜索引擎相邻」这一类,把 R6 点名的四个合法改名收进来;
//   sanitize 后失去信息的非 ASCII 名**仍然漏**,这条以回归的形式钉住(见测试同名用例)。
//
//   **例外(治理云 server)= 绑定 alpha 自己写的那份定义的端点身份,不再看名字前缀。**
//   `ALPHA_CLOUD_MCP_DEF` 里的 `url` 是 alpha 在**本次 fork** 自己写进 env 的(injectAlphaConfig
//   在每条分支上覆盖或删除它),外部伪造不了;`computeMcpOwnership()` 在 `config` 钩子里拿**引擎
//   已合并完成的**配置逐个核对:名字等于点名的那个、`type==="remote"`、`url` 逐字相同,才算治理
//   server。工具归属按 sanitize 后的 server 名前缀解析,**任何歧义都倒向 fail-closed**:只要有
//   一个可能的归属方不是治理 server,豁免就不给。因此 `cloud_attacker_web_search` 与
//   `cloud_web`+`search` 都拿不到豁免,照常被判 deny。
//
// **本票保证的范围(R6 裁决,ADR-009 同步收窄)**:
//   - alpha 治理的云 server(按上述**定义身份**识别)—— 保证;
//   - alpha 自有的本地 websearch 工具(传输层闸,ADR-035)—— 保证;
//   - 用户自配的第三方 web-search MCP —— **不在**本票保证内。按名字识别做不到,且已实测可绕
//     (非 ASCII 名、`POST /mcp` 自带定义新装一个 server)。本闸对它是**尽力拦截**,不是保证。
//
// 已知边界(不谎称穷尽):本闸只覆盖**引擎内**的 MCP / code-mode 工具执行 —— 它跑在 ext 装载
// 之后。ext 缺席时(见下方握手段)本闸不存在,那时能守住的只有「云 server 的定义根本不进配置、
// 且任何继承来的同名条目都被中和」与本地 websearch 工具自身的闸。本闸也不改变远端 MCP 目录本身
// (server 仍然会 advertise 这些工具),更够不着任何绕过 opencode 工具循环直接说 MCP 协议的客户端;
// 运行时 `POST /mcp` 用**同一个名字**换掉已连的客户端,从 ext 的视角与原客户端不可分辨 —— 上游
// 没有任何接口把「当前活着的 server 定义」暴露给插件,而收编 `handlers/mcp.ts` / `mcp/index.ts`
// 不在本票范围;那条路装的是「用户自己新装的第三方 MCP」,正落在上面收窄掉的那一类里。
//
// ─────────────────────────────────────────────────────────────────────────────
// #223 R7 Blocker:归属快照是**每个插件实例**的,模块里不许留可变状态。
//
// R6 的端点身份核验本身成立,但结果被存进本模块的一个模块级 `let`。本模块由 Bun 动态 import
// **缓存**(一个引擎进程只有一份),而 Plugin / MCP 状态按 directory 建实例 —— 后跑的实例于是
// 覆盖先跑的快照。R7 只读探针实测:实例 A 记录正常 `cloud` 后 `cloud_web_search` 放行;实例 B
// 只要多记一个 foreign `cloud_web`,A 的**同一个**权威云工具立刻被误拒。一个项目因此能改变另一个
// 项目云工具的可用性 —— 违反本文件对治理云 server 的保证,也违反 AC4「不误杀」。
//
// 本轮的形态:本模块只留**纯函数**(`computeMcpOwnership`),归属由 `plugin.ts` 存在**每个
// `AlphaExt` 实例自己的闭包**里,在该实例全部配置合并完成之后(项目 `alpha.jsonc` 合并之后)才算,
// 并显式传给该实例的 `tool.execute.before`。判决函数的默认实参恒为 `UNVERIFIED_MCP_OWNERSHIP`
// —— 没传归属 = 没有治理 server = 豁免不给,fail-closed 不因这次重构而松动。
//
// 同轮的 Minor:分类判据 ②(`search` + 具名搜索引擎词)此前按**词元集合同时出现**判,而上面这段
// 与 ADR-009 写的都是**相邻** —— 两张皮,且集合判会误杀 `brave_translate_and_search` /
// `internet_archive_search` 一类第三方工具(与 AC4 反向)。改**实现**为真正的相邻判定。
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
 * 具名 web search 引擎词。只收**专职**网页搜索的产品名 —— `google` / `bing` 这类同时是文档、
 * 地图、邮件的品牌不收,免得把 `gdrive_search`、`bing_maps_search` 一类误杀(AC4)。
 * 这是启发式词表,**非穷尽**,加词不改变任何保证的形状。
 */
const SEARCH_ENGINE_WORDS = new Set([
  "web",
  "internet",
  "online",
  "brave",
  "exa",
  "tavily",
  "perplexity",
  "serper",
  "serpapi",
  "duckduckgo",
  "ddg",
  "searx",
  "searxng",
  "kagi",
])

/** 工具 id → 小写词元。切 `_` / `-` 等分隔符,并切 camelCase 边界(`websearchTool` → web…/Tool)。 */
function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

/**
 * 命中判据 = 这个工具 id **看起来**是一个 web search。**尽力而为,不谎称穷尽**(#223 R6)。
 *
 * MCP 工具 id 由 `McpCatalog.toolName` 拼成 `<server>_<tool>`,所以 alpha 注入的云 server
 * (`cloud`)上的 `web_search` 落地为 `cloud_web_search`,而用户自带的 exa remote MCP 落地为
 * `exa_web_search_exa`(前缀是 server 名、后缀是工具名自带的)。刻意不写死任何字面量:平台或
 * 第三方把工具改名成 `web_search_v2` 之类时闸不能哑掉。兄弟云工具(`cloud_dispatch` /
 * `cloud_status` / `cloud_await` / `cloud_artifacts` / `cloud_schedule_*`)一律不命中 ——
 * AC4 要求的「不误杀」。
 *
 * 两条判据:
 *   ① 去掉全部分隔符后含 `websearch` / `searchweb` —— 覆盖 `web_search`、`web-search`、
 *      `search_web`、`websearchTool`、`exa_web_search_exa`、`web_search_v2` 等一切写法;
 *   ② `search` 与一个具名搜索引擎词**相邻** —— 覆盖 `brave-search`、`tavily_search`。
 *
 * ②**必须是相邻,不是「同时出现」**(#223 R7 out-of-round Minor):按集合判会把
 * `brave_translate_and_search`、`internet_archive_search` 一类第三方工具误杀,那与 AC4「不误杀」
 * 反向。相邻判据同时让实现与本注释宣称的口径一致(此前文档说相邻、实现按集合,是两张皮)。
 *
 * **已知漏洞(R6 实测,以回归钉住)**:非 ASCII 工具名经 `McpCatalog.sanitize`
 * (`[^a-zA-Z0-9_-]` → `_`)后只剩下划线,任何按名字的分类器都看不见它。因此「按名字关掉一切
 * 第三方 web-search MCP」**做不到**,ADR-009 已按此收窄宣称:第三方 web-search MCP 不在本票
 * 保证内,本闸对它是尽力拦截。
 */
export function isWebSearchToolId(tool: string): boolean {
  const glued = tool.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (glued.includes("websearch") || glued.includes("searchweb")) return true
  const words = toolWords(tool)
  for (let i = 1; i < words.length; i++) {
    const [left, right] = [words[i - 1]!, words[i]!]
    if (left === "search" && SEARCH_ENGINE_WORDS.has(right)) return true
    if (right === "search" && SEARCH_ENGINE_WORDS.has(left)) return true
  }
  return false
}

/** alpha 自己注册的云 MCP server 名(注入面经 `ALPHA_CLOUD_MCP_SERVER` 告知,见 ui-mac 同名常量)。 */
export const CLOUD_MCP_SERVER_ENV = "ALPHA_CLOUD_MCP_SERVER"

/** `McpCatalog.sanitize`(`opencode/src/mcp/catalog.ts:117`)逐字同义 —— 工具 id 的前缀就是它的产物。 */
function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * 引擎给远端 MCP 工具起的 id,`McpCatalog.toolName`(`opencode/src/mcp/catalog.ts:119`)逐字同义:
 * `sanitize(server) + "_" + sanitize(remote)`。
 *
 * **#650**:`remoteName` 是远端 server **自己** advertise 的名字,不是引擎里的 id。云 worker 的
 * 远端名自带 `cloud_` 前缀(`cloud_web_search` / `cloud_dispatch` …),拼上 server 名 `cloud` 之后
 * 真实 id 是 `cloud_cloud_*` —— 把远端名当 id 用过的地方,闸一次都没生效过。ext 不依赖 opencode,
 * 拼法只能在这里再写一份;漂移由 `cloud-contract-hook.test.ts` 用**真的** `McpCatalog.toolName` 钉住。
 */
export function mcpEngineToolId(server: string, remoteName: string): string {
  return `${sanitizeMcpName(server)}_${sanitizeMcpName(remoteName)}`
}

/**
 * 一次配置装载里,每个 MCP server 名的**治理归属**。
 *
 * `governed` = 端点身份核验通过的 alpha 云 server(名字等于 `ALPHA_CLOUD_MCP_SERVER` 点名的那个,
 * 且配置里那条定义是 `type:"remote"` 且 `url` 与 `ALPHA_CLOUD_MCP_DEF` 里 alpha 自己写的逐字相同)。
 * `foreign` = 配置里其余每一个 server 名 —— 一个都拿不到治理豁免。
 */
export type McpOwnership = {
  governed: string[]
  foreign: string[]
}

/**
 * 尚未核验(config 钩子还没跑 / 配置里没有 mcp 段 / 合并中途失败)= 没有任何治理 server,
 * 豁免一律不给。这是判决函数的默认实参 —— 调用方不传归属时永远 fail-closed。
 */
export const UNVERIFIED_MCP_OWNERSHIP: McpOwnership = { governed: [], foreign: [] }

/**
 * alpha 在**本次 fork** 自己写进 env 的那份云 server 定义的端点身份。
 *
 * 不可伪造的根据与 ARM/DEF 握手同一条:`injectAlphaConfig` 在每次 fork 的**每一条分支**上覆盖或
 * 删除 `ALPHA_CLOUD_MCP_SERVER` / `ALPHA_CLOUD_MCP_DEF`,继承来的值一律不作数(逃生阀
 * `ALPHA_ENV_ALLOWLIST_EXTRA` 能把名字放进 sidecar,但放不进一个活过注入面的值)。
 */
function governedCloudEndpoint(
  env: Record<string, string | undefined>,
): { name: string; url: string } | undefined {
  const name = env[CLOUD_MCP_SERVER_ENV]
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!name || !raw) return undefined
  let definition: unknown
  try {
    definition = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return undefined
  const { type, url } = definition as { type?: unknown; url?: unknown }
  if (type !== "remote" || typeof url !== "string" || !url) return undefined
  return { name, url }
}

function isGovernedEntry(entry: unknown, endpoint: { url: string }): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const { type, url } = entry as { type?: unknown; url?: unknown }
  return type === "remote" && url === endpoint.url
}

/**
 * 从一份**已合并完成的**引擎配置算出治理归属。
 *
 * **纯函数,不写任何模块级状态**(#223 R7 Blocker):本模块由 Bun 动态 import **缓存**,一个引擎
 * 进程只有一份;而 Plugin / MCP 状态按 directory 建实例,同一份模块被多个 `AlphaExt` 实例共用。
 * 归属一旦存进模块级变量,后跑的实例就会覆盖先跑的实例的快照 —— 实测:实例 B 记录一个 foreign
 * `cloud_web` 后,实例 A 的 `cloud_web_search` 立刻被误拒(跨项目串扰)。因此归属由调用方
 * (`plugin.ts` 里**每个实例自己的闭包**)保存,并显式传给判决函数。
 */
export function computeMcpOwnership(
  cfg: unknown,
  env: Record<string, string | undefined> = process.env,
): McpOwnership {
  const host = cfg as McpHost | null | undefined
  if (!host || typeof host !== "object") return UNVERIFIED_MCP_OWNERSHIP
  const servers = host.mcp && typeof host.mcp === "object" ? host.mcp : {}
  const endpoint = governedCloudEndpoint(env)
  const governed: string[] = []
  const foreign: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (endpoint && name === endpoint.name && isGovernedEntry(entry, endpoint)) governed.push(name)
    else foreign.push(name)
  }
  return { governed, foreign }
}

/**
 * 工具 id 的可能归属方。sanitize 不是单射,而 `<server>_<tool>` 的边界也不唯一
 * (`cloud_web` + `search` 与 `cloud` + `web_search` 拼出同一个 id),所以这里收集**全部**候选。
 */
function ownersOf(tool: string, ownership: McpOwnership) {
  const match = (names: string[]) => names.filter((name) => tool.startsWith(`${sanitizeMcpName(name)}_`))
  return { governed: match(ownership.governed), foreign: match(ownership.foreign) }
}

/**
 * 治理豁免判据(#223 R6):**只有**当这个工具 id 唯一可能来自已核验端点身份的那个 server 时才成立。
 *
 * 任何歧义都倒向 fail-closed:候选里出现任何一个非治理 server(`cloud_attacker`、`cloud_web` …),
 * 或者一个候选都没有(运行时新装的 server、config 钩子没跑),豁免都不给。
 */
function isGovernedCloudTool(tool: string, ownership: McpOwnership): boolean {
  const owners = ownersOf(tool, ownership)
  return owners.governed.length > 0 && owners.foreign.length === 0
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
  ownership: McpOwnership = UNVERIFIED_MCP_OWNERSHIP,
): string | undefined {
  if (!isWebSearchToolId(tool)) return undefined
  if (isGovernedCloudTool(tool, ownership))
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
export function assertWebSearchToolAllowed(
  tool: string,
  env: Record<string, string | undefined> = process.env,
  ownership: McpOwnership = UNVERIFIED_MCP_OWNERSHIP,
): void {
  const reason = webSearchToolDenial(tool, env, ownership)
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
// `tool.execute.before` 闸确实注册了。三种缺席情形下本函数一次都不会被调用。
//
// **R6 Major 修正**:R5 声称此时「配置里没有任何名为 cloud 的条目」,那只对
// `OPENCODE_CONFIG_CONTENT` 自己那一份成立。引擎另外还加载 XDG global、`OPENCODE_CONFIG`、项目
// 目录与 managed 配置,深合并里「缺少某个键」**不会删除**先前来源的定义(`config/config.ts`)——
// 于是那些来源里的一份完整 `cloud` 定义照样自动连接,`enabled:false` 也照样能被 `/connect` 翻开。
// 注入面因此改为写一份**中和条目**(`ui-mac/src/main/cloud-web-search.ts` 的 `WITHHELD_CLOUD_MCP`:
// `type:"remote"` + 一个不做 DNS、必然 ECONNREFUSED 的 `127.0.0.1:1` URL + `enabled:false`),深合并里
// **覆盖连接控制字段**(`type`/`url`/`enabled`/`oauth`)压过任何继承来的 `cloud`;本函数在 ext 确认装载后
// **整条替换**它。(#223 R7 措辞更正:不是「逐字段完整覆盖」—— 真实 `mergeDeep` 探针显示继承的
// `headers` / `timeout` 会留下;URL 已是不可用 loopback,它们发不出去,但宣称必须写准。)ext 缺席 ⇒ 留下的是那份
// 中和条目 ⇒ `/mcp/cloud/connect` 连不上任何东西,连兄弟云工具一起损失 —— 诚实的 fail-closed 降级。
// 覆盖不到的只有 managed 目录与 MDM 托管偏好(引擎把它们排在 `OPENCODE_CONFIG_CONTENT` **之后**),
// 那两个都是 root/管理员通道,不在用户威胁模型内 —— 事实由多源加载回归钉住,不谎称已关。
//
// 仍够不着的一条(诚实登记):`POST /mcp` 的 `add` 要求调用方**自带**完整 server 定义,所以它
// 不是「复活已存在的定义」,而是新装一个 —— 拦它等于拦任意第三方 MCP,那要收编上游
// `handlers/mcp.ts` / `mcp/index.ts`,不在本票范围。用**同一个名字** add 会替换掉已连的客户端,
// 而上游没有任何接口把「当前活着的 server 定义」暴露给插件,所以从 ext 的视角它与原客户端不可
// 分辨 —— 那条路装的正是「用户自己新装的第三方 MCP」,落在 R6 收窄掉的那一类里(见文件头)。
// ─────────────────────────────────────────────────────────────────────────────

/** 注入面告诉 ext「这个 MCP server 等你确认装载后才能装」的通道(ui-mac `cloud-web-search.ts` 同名同义)。 */
export const CLOUD_MCP_ARM_ENV = "ALPHA_CLOUD_MCP_ARM"

/**
 * 与 ARM 配对的 server 定义(JSON)。
 *
 * `#733` 起 alpha 治理的云 server 走标准 MCP OAuth,这份定义里**没有任何凭证通道**
 * (无 `headers.Authorization`、无 `{file:…}` 引用)。下面的 `resolveFileRefs` 因此对它
 * 是个 no-op —— 保留它不是为了将来:注入面托管的是一个任意 JSON,含 `{file:}` 时那条
 * fail-closed(读不到就整个不装)仍然是这里唯一的把关,删掉它等于对未来任何带引用的定义
 * 默认放行。
 */
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
