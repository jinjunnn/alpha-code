// cloud-mcp-auth-sweep —— REQ-144 T3(#1196):退役云 MCP 交互式 OAuth 后,引擎共享凭证库
// `<engineData>/mcp-auth.json` 里遗留的 `cloud` entry 一次性清扫。
//
// 地面真相(动手前勘破,#1196 票面要求):
//   - 该文件是**所有** MCP server 共用的令牌库(packages/opencode/src/mcp/auth.ts,
//     `Record<name, Entry>`,0600)。第三方 server 的 entry 仍在生产使用 —— **只准摘 `cloud` 键**,
//     其余键逐字保留;动别人的 entry 是事故。
//   - `#1195`(T2)起云 server 定义为 `oauth:false`,引擎对它不构造 McpOAuthProvider、
//     不碰 mcp-auth.json —— `cloud` entry 从此只会是历史残留(owner 机器上实测为
//     `{codeVerifier, oauthState, serverUrl}` 的中间态,~10 分钟换血打断交互授权留下的,
//     见基线 §1.6),不会再被写回;首次摘除后本清扫收敛为 no-op。
//   - 摘除的消费者:T4-① 的判据「mcp-auth.json 无 cloud tokens(证明没走交互路)」——
//     遗留 tokens 会污染那格证据。
//   - 时序:调用点在 boot、sidecar fork 之前(index.ts,与 runBootDanglingSweep 同段)——
//     此刻引擎进程还不存在,不与它的 flock 竞争。
//
// fail-closed 语义:文件缺席 / 解析失败 / 形状不对 / 无 `cloud` 键 ⇒ **零写入**
// (解析不了的文件不是我们的,重写它才是事故);只有确认摘掉了 `cloud` 才落盘。
// data-clear.ts 同形态:electron-free,fs 依赖全注入以便单测。

import * as fs from "node:fs"
import * as path from "node:path"
import { CLOUD_MCP_SERVER_NAME } from "./cloud-web-search"

/** 与引擎 packages/opencode/src/mcp/auth.ts 的 `filepath` 同一 basename。 */
export const ENGINE_MCP_AUTH_FILE = "mcp-auth.json"

export type SweepFsDeps = {
  /** utf8 读;缺席/不可读返回 null。 */
  readFile(p: string): string | null
  /** 覆盖写(文件已存在时保留既有 0600 权限;新建按 0o600)。 */
  writeFile(p: string, content: string): void
}

export type CloudMcpAuthSweepOutcome =
  | { action: "removed"; path: string }
  | { action: "none"; reason: "absent" | "unparseable" | "not-object" | "no-cloud-entry" }

const realDeps: SweepFsDeps = {
  readFile(p) {
    try {
      return fs.readFileSync(p, "utf8")
    } catch {
      return null
    }
  },
  writeFile(p, content) {
    fs.writeFileSync(p, content, { mode: 0o600 })
  },
}

export function engineMcpAuthPath(engineDataPath: string): string {
  return path.join(engineDataPath, ENGINE_MCP_AUTH_FILE)
}

/** 摘掉遗留的 `cloud` entry;其余 entry 逐字保留。幂等:无 `cloud` 键即零写入。 */
export function sweepLegacyCloudMcpAuthEntry(
  engineDataPath: string,
  deps: SweepFsDeps = realDeps,
): CloudMcpAuthSweepOutcome {
  const file = engineMcpAuthPath(engineDataPath)
  const raw = deps.readFile(file)
  if (raw === null) return { action: "none", reason: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { action: "none", reason: "unparseable" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "none", reason: "not-object" }
  const data = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(data, CLOUD_MCP_SERVER_NAME)) {
    return { action: "none", reason: "no-cloud-entry" }
  }
  const { [CLOUD_MCP_SERVER_NAME]: _removed, ...rest } = data
  deps.writeFile(file, JSON.stringify(rest, null, 2))
  return { action: "removed", path: file }
}
