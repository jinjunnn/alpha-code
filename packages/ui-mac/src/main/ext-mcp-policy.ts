// ext-mcp-policy — REQ-105 #254 + REQ-133:MCP 写盘的 main 侧 Office 策略闸口(单一入口)。
//
// 背景:Excel MCP(excel-mcp-server)的 workspace 沙箱只有在传入 workspace 根时才校验目录边界;
// 生产安装路径此前调用 checkExcelMcpSafety 漏传该参 → 沙箱形同虚设(fail-open)。此模块把
// 「解析 workspace 根 → 注入固定路径 / Alpha bundled server → fail-closed 校验」收敛成唯一包装器,
// legacy IPC(ext-persist-mcp)与 main-only planner 的 installers.persistMcp 都指向它,从结构上
// 消除「某个调用点忘传 workspace」的缺口。主机绝对路径由 main 决定,绝不采信 renderer/catalog 值。

import * as fs from "node:fs"
import * as path from "node:path"
import type { InstallMeta } from "../preload/types"
import type { ConfigResult } from "./ext-config"
import { persistMcp } from "./ext-config"
import { alphaUserWorkspaceDir } from "./alpha-user-workspace"
import {
  ALPHA_OFFICE_CONNECTORS,
  alphaOfficeInstallCommand,
  checkAlphaOfficeMcpSafety,
  checkExcelMcpSafety,
  isAlphaOfficeMcp,
  isExcelMcp,
} from "../shared/office-advisories"
import { resourcesRoot } from "./ext-fs-installer"

/** 受管 Excel 文件根:`~/Alpha/excel-workspace`。选专属子目录而非「当前 session 项目目录」——
 *  MCP 配置/receipt 是全局持久化,绑到安装时的某个项目会造成跨项目泄露与陈旧绑定(Codex 裁决)。 */
export function excelWorkspaceRoot(): string {
  return path.join(alphaUserWorkspaceDir(), "excel-workspace")
}

/** 建立并 canonicalize 受管 Excel workspace 根;失败返回 null(调用方 fail-closed 拒绝安装)。 */
export function ensureExcelWorkspaceRoot(): string | null {
  const dir = excelWorkspaceRoot()
  try {
    fs.mkdirSync(dir, { recursive: true })
    return fs.realpathSync(dir) // 解析 symlink,与 EXCEL_FILES_PATH 用同一 canonical 值
  } catch {
    return null
  }
}

/** 对触及 Excel 的 server 注入固定受管 EXCEL_FILES_PATH 并做 fail-closed 校验。非 Excel server 透传。 */
function applyExcelWorkspacePolicy(name: string, server: Record<string, unknown>): ConfigResult {
  if (!isExcelMcp(name, server)) return { ok: true }
  const workspace = ensureExcelWorkspaceRoot()
  if (!workspace) return { ok: false, reason: "无法建立受管 Excel workspace 根(REQ-105 #254 fail-closed)" }
  // main 注入固定文件根,覆盖 renderer/catalog 提供的任何 EXCEL_FILES_PATH。
  const env =
    server.environment && typeof server.environment === "object" && !Array.isArray(server.environment)
      ? (server.environment as Record<string, unknown>)
      : {}
  env.EXCEL_FILES_PATH = workspace
  server.environment = env
  return checkExcelMcpSafety(name, server, workspace)
}

/** Canonicalize the granted workspace and replace the catalog resource placeholder with Alpha's
 *  actual bundled server. Static command tokens/pins must already match the registry exactly. */
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
      argument !== "{workspace}" && !argument.includes("{alphaResources}") && command[index] !== argument,
    )
  ) {
    return { ok: false, reason: `${connector.name} command differs from the pinned Alpha stdio command (REQ-133)` }
  }
  const workspaceArg = command[template.indexOf("{workspace}")]
  if (!workspaceArg || !path.isAbsolute(workspaceArg) || workspaceArg.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: `${connector.name} requires an absolute traversal-free workspace grant (REQ-133)` }
  }
  try {
    const workspace = fs.realpathSync(workspaceArg)
    const alphaResources = fs.realpathSync(resourcesRoot())
    const serverPath = fs.realpathSync(path.join(alphaResources, "office-mcp", "server.py"))
    if (path.relative(alphaResources, serverPath).startsWith(`..${path.sep}`)) {
      return { ok: false, reason: `${connector.name} bundled server escaped Alpha resources (REQ-133)` }
    }
    server.command = template.map((argument) =>
      argument.replace("{alphaResources}/office-mcp/server.py", serverPath).replace("{workspace}", workspace),
    )
    return checkAlphaOfficeMcpSafety(name, server, workspace, alphaResources)
  } catch {
    return { ok: false, reason: `${connector.name} workspace or bundled server is unavailable (REQ-133 fail-closed)` }
  }
}

/** #378(Codex 裁决 Q2):策略闸口的持久化剥离面 —— 单装事务先注入策略再把最终 durable 交
 *  config action(引擎落盘),不得经 persistMcp 直写。mkdir/realpath 属**非权威 provisioning**:
 *  authorize 暂停后残留的只是空受管目录,零 config/账本/密钥副作用。 */
export function applyMcpWritePolicy(name: string, server: Record<string, unknown>): ConfigResult {
  if (server && typeof server === "object") {
    const excel = applyExcelWorkspacePolicy(name, server)
    if (!excel.ok) return excel
    return applyAlphaOfficeWorkspacePolicy(name, server)
  }
  return { ok: false, reason: "invalid server config" }
}

/** MCP 写盘唯一策略入口(未策展直写通道):先过 Excel workspace 闸口(拒绝即 fail-closed
 *  不落盘),再 persistMcp。单装 catalog 事务走 applyMcpWritePolicy + config action。 */
export function persistMcpWithPolicy(name: string, server: Record<string, unknown>, meta?: InstallMeta): ConfigResult {
  if (server && typeof server === "object") {
    const policy = applyMcpWritePolicy(name, server)
    if (!policy.ok) return policy
  }
  return persistMcp(name, server, meta)
}
