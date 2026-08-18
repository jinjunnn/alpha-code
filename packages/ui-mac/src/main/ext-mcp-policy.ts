// ext-mcp-policy — REQ-133 + REQ-135:MCP 写盘的 main 侧 Office 策略闸口(单一入口)。
//
// Alpha bundled Office server 的资源与 workspace 路径只能由 main canonicalize;legacy IPC
// (ext-persist-mcp)与 main-only planner 都走这里。REQ-135 另在同一咽喉拒绝已退役的社区
// Excel 身份/包命令,但不保留其 workspace、环境变量或兼容安装策略。

import * as fs from "node:fs"
import * as path from "node:path"
import type { InstallMeta } from "../preload/types"
import type { ConfigResult } from "./ext-config"
import { persistMcp } from "./ext-config"
import {
  ALPHA_OFFICE_CONNECTORS,
  WORKSPACE_MARKER,
  alphaOfficeInstallCommand,
  checkAlphaOfficeMcpSafety,
  isAlphaOfficeMcp,
  isRetiredOfficeMcp,
} from "../shared/office-advisories"
import { resourcesRoot } from "./ext-fs-installer"

/** Require the spawn-time workspace marker and replace the catalog resource placeholder with
 *  Alpha's actual bundled server. Boot reconciliation owns legacy concrete-path migration.
 *  Static command tokens/pins must already match the registry exactly. */
function applyAlphaOfficeWorkspacePolicy(name: string, server: Record<string, unknown>): ConfigResult {
  if (!isAlphaOfficeMcp(name, server)) return { ok: true }
  const command = Array.isArray(server.command) && server.command.every((argument) => typeof argument === "string")
    ? (server.command as string[])
    : []
  const connector = ALPHA_OFFICE_CONNECTORS.find((candidate) =>
    candidate.name === name || command.includes(candidate.format),
  )
  if (!connector) return { ok: false, reason: "unknown Alpha Office connector mode (REQ-133 fail-closed)" }
  const template = alphaOfficeInstallCommand(connector.format)
  if (
    command.length !== template.length ||
    template.some((argument, index) =>
      argument !== WORKSPACE_MARKER && !argument.includes("{alphaResources}") && command[index] !== argument,
    )
  ) {
    return { ok: false, reason: `${connector.name} command differs from the pinned Alpha stdio command (REQ-133)` }
  }
  const workspaceArg = command[template.indexOf(WORKSPACE_MARKER)]
  if (workspaceArg !== WORKSPACE_MARKER) {
    return { ok: false, reason: `${connector.name} requires the exact workspace marker (REQ-134)` }
  }
  try {
    const alphaResources = fs.realpathSync(resourcesRoot())
    const serverPath = fs.realpathSync(path.join(alphaResources, "office-mcp", "server.py"))
    if (path.relative(alphaResources, serverPath).startsWith(`..${path.sep}`)) {
      return { ok: false, reason: `${connector.name} bundled server escaped Alpha resources (REQ-133)` }
    }
    server.command = template.map((argument) =>
      argument.replace("{alphaResources}/office-mcp/server.py", serverPath),
    )
    return checkAlphaOfficeMcpSafety(name, server, WORKSPACE_MARKER, alphaResources)
  } catch {
    return { ok: false, reason: `${connector.name} bundled server is unavailable (REQ-133 fail-closed)` }
  }
}

/** #378(Codex 裁决 Q2):策略闸口的持久化剥离面 —— 单装事务先应用策略再把最终 durable 交
 *  config action(引擎落盘),不得经 persistMcp 直写。 */
export function applyMcpWritePolicy(name: string, server: Record<string, unknown>): ConfigResult {
  if (server && typeof server === "object") {
    if (isRetiredOfficeMcp(name, server)) {
      return { ok: false, reason: "community excel-mcp-server is retired; use mcp:alpha-excel (REQ-135)" }
    }
    return applyAlphaOfficeWorkspacePolicy(name, server)
  }
  return { ok: false, reason: "invalid server config" }
}

/** MCP 写盘唯一策略入口(未策展直写通道):先过 Office 策略(拒绝即 fail-closed 不落盘),
 *  再 persistMcp。单装 catalog 事务走 applyMcpWritePolicy + config action。 */
export function persistMcpWithPolicy(name: string, server: Record<string, unknown>, meta?: InstallMeta): ConfigResult {
  if (server && typeof server === "object") {
    const policy = applyMcpWritePolicy(name, server)
    if (!policy.ok) return policy
  }
  return persistMcp(name, server, meta)
}
