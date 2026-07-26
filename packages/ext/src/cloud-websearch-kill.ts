// cloud-websearch-kill — ADR-009 B2 的 web search kill-switch 在**云工具**一侧的最终闸(#223 R3)。
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
// 判决不由本模块推导:main 的 `applyWebSearchSovereignty()`(`ui-mac/src/main/server.ts`)在每次
// fork 前同步置位/删除 `ALPHA_CLOUD_WEBSEARCH_DENY`,`sidecar-env.ts` 的白名单把它带进 sidecar。
//
// 已知边界(不谎称穷尽):本闸只覆盖**引擎内**的 MCP / code-mode 工具执行。它不改变远端 MCP
// 目录本身(server 仍然会 advertise 这个工具),也够不着任何绕过 opencode 工具循环直接说 MCP
// 协议的客户端。

/** main 每次 fork 前落定的云侧主权判决通道(`ui-mac/src/main/cloud-web-search.ts` 同名同义)。 */
export const CLOUD_WEBSEARCH_DENY_ENV = "ALPHA_CLOUD_WEBSEARCH_DENY"

/** fail-closed:除「缺省 / 空串 / `"0"`」外的任何取值都判为 deny。与本地那条逐字同义。 */
export function cloudWebSearchDenied(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[CLOUD_WEBSEARCH_DENY_ENV]
  return value !== undefined && value !== "" && value !== "0"
}

/**
 * 命中判据 = 工具 id 的**末段**正是一个 web search。
 *
 * MCP 工具 id 由 `McpCatalog.toolName` 拼成 `<server>_<tool>`,所以 alpha 注入的云 server
 * (`cloud`)上的 `web_search` 落地为 `cloud_web_search`。刻意不写死这一个字面量:平台把工具
 * 改名成 `web_search_v2` 之类时闸不能哑掉。兄弟云工具(`cloud_dispatch` / `cloud_status` /
 * `cloud_await` / `cloud_artifacts` / `cloud_schedule_*`)一律不命中 —— AC4 要求的「不误杀」。
 *
 * 命中面不限于 cloud server:kill-switch 的语义是 ADR-009 的「不留下任何活的 web_search」,
 * 用户自带 MCP 上的同形工具同样该关。
 */
export function isWebSearchToolId(tool: string): boolean {
  return /(^|_)web_?search(_[a-z0-9]+)*$/i.test(tool)
}

export class WebSearchKillSwitchError extends Error {
  constructor(tool: string) {
    super(
      `${tool} is unavailable: the alpha web search kill switch (ADR-009 B2) is set. ` +
        "This is not a transient failure and no permission grant can lift it; do not retry. " +
        "Answer without web search and say so.",
    )
    this.name = "WebSearchKillSwitchError"
  }
}

/** `tool.execute.before` 的首行。命中即抛 —— 抛出点早于 `ctx.ask`,故 approved/后置 allow 够不着。 */
export function assertWebSearchToolAllowed(tool: string, env: Record<string, string | undefined> = process.env): void {
  if (!isWebSearchToolId(tool)) return
  if (!cloudWebSearchDenied(env)) return
  throw new WebSearchKillSwitchError(tool)
}
