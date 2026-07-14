// ext-mcp-policy — REQ-105 #254:MCP 写盘的 main 侧策略闸口(单一入口)。
//
// 背景:Excel MCP(excel-mcp-server)的 workspace 沙箱只有在传入 workspace 根时才校验目录边界;
// 生产安装路径此前调用 checkExcelMcpSafety 漏传该参 → 沙箱形同虚设(fail-open)。此模块把
// 「解析受管 workspace 根 → 注入固定 EXCEL_FILES_PATH → fail-closed 校验」收敛成唯一包装器,
// legacy IPC(ext-persist-mcp)与 main-only planner 的 installers.persistMcp 都指向它,从结构上
// 消除「某个调用点忘传 workspace」的缺口。主机绝对路径由 main 决定,绝不采信 renderer/catalog 值。

import * as fs from "node:fs"
import * as path from "node:path"
import type { InstallMeta } from "../preload/types"
import type { ConfigResult } from "./ext-config"
import { persistMcp } from "./ext-config"
import { alphaUserWorkspaceDir } from "./alpha-user-workspace"
import { checkExcelMcpSafety, isExcelMcp } from "../shared/office-advisories"

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

/** MCP 写盘唯一策略入口:先过 Excel workspace 闸口(拒绝即 fail-closed 不落盘),再 persistMcp。 */
export function persistMcpWithPolicy(name: string, server: Record<string, unknown>, meta?: InstallMeta): ConfigResult {
  if (server && typeof server === "object") {
    const policy = applyExcelWorkspacePolicy(name, server)
    if (!policy.ok) return policy
  }
  return persistMcp(name, server, meta)
}
