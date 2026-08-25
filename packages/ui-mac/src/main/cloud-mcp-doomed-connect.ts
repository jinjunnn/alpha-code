// #1106 — fork 前判定:云 MCP 的 boot 连接是不是**注定** `needs_auth`。
//
// 为什么这件事在 fork 前就可判:引擎连接远程 MCP 时取凭证的唯一入口是
// `McpOAuthProvider.tokens()` → `McpAuth.getForUrl(name, config.url)`
// (`packages/opencode/src/mcp/auth.ts`):entry 存在、`entry.serverUrl` 逐字等于配置 url、
// `entry.tokens` 在,三者缺一即无凭证 ⇒ 首个请求 401 ⇒ `needs_auth`,结构上不可能连上。
// 而 entry 就落在 `<engineData>/mcp-auth.json` 里 —— fork 那一刻它已经定了。
//
// 判定为 doomed 时注入面写 `enabled:false`(见 alpha-config-injection.ts):引擎 `MCP.create`
// 对 `enabled:false` 直接返回 DISABLED_RESULT(`packages/opencode/src/mcp/index.ts:397`),
// boot 零等待 —— owner 日志实测 27/27 次轮换 boot 的 1.79–9.67s 阻塞段全部以
// `key=cloud status=needs_auth` 收尾,这个等待买不来任何东西。
//
// 镜像纪律(与引擎判据的对应关系,偏差只允许朝「保持今天行为」的方向):
//   - 文件不存在(ENOENT)          → doomed(引擎 readJson 失败落 `{}` ⇒ 无凭证);
//   - 文件在但读不了(EACCES 等)   → **不** doomed(fail-open:最坏 = 今天的 boot 等待);
//   - JSON 解析失败                 → doomed(引擎 decode 失败同样落 `{}`);
//   - entry 缺 / 形状不对           → doomed;
//   - `serverUrl` 缺或不等          → doomed(`getForUrl` 两个分支都返回 undefined);
//   - `tokens.accessToken` 空串     → doomed(引擎 schema 收下它,但发出去就是 401);
//   - tokens 过期但在               → **不** doomed(引擎会拿 refreshToken 续,可能成功)。
//
// electron-free:注入跑在 sidecar utility process 里(与引擎同进程同 env),单测直接 import。

import * as fs from "node:fs"
import * as path from "node:path"

/** 引擎的 MCP OAuth 凭证库(`packages/opencode/src/mcp/auth.ts` 的 `filepath` 同构)。 */
export function mcpAuthPath(engineDataPath: string): string {
  return path.join(engineDataPath, "mcp-auth.json")
}

export function isCloudMcpConnectDoomed(engineDataPath: string, serverName: string, serverUrl: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(mcpAuthPath(engineDataPath), "utf8")
  } catch (error) {
    // 文件不存在 = 这个引擎数据目录上从未落过任何 MCP 凭证 ⇒ 注定 401。
    // 其余读错误(权限等)是「看不见」不是「没有」—— fail-open 保持今天的行为。
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true // 引擎侧 decode 失败同样落 `{}` ⇒ 无凭证可用
  }
  if (!parsed || typeof parsed !== "object") return true
  const entry = (parsed as Record<string, unknown>)[serverName]
  if (!entry || typeof entry !== "object") return true
  const record = entry as { serverUrl?: unknown; tokens?: unknown }
  if (record.serverUrl !== serverUrl) return true
  const tokens = record.tokens
  if (!tokens || typeof tokens !== "object") return true
  const accessToken = (tokens as { accessToken?: unknown }).accessToken
  return !(typeof accessToken === "string" && accessToken.length > 0)
}
