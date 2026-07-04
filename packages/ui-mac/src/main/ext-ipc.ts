// Extension Hub IPC handlers (main process). Mirrors ipc.ts's ipcMain.handle pattern. Three thin
// privileged operations the renderer can't do itself: persist/remove an MCP server in the user
// config (ext-config.ts), and a runtime which-check so the UI can warn before adding a local MCP
// whose binary (uv/node/…) is missing. All validation lives in ext-config / here — see ADR-014 §8.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as os from "node:os"
import type { InstallMeta, InstallReceipt, InstallTarget } from "../preload/types"
import { listInstalls } from "./alpha-installs"
import { fileifyMcpSecrets, removeMcpServerSecrets } from "./alpha-mcp-secrets"
import { isMigrationEnabled, removeLegacy, scanLegacy } from "./alpha-migrate"
import { configHealth, persistMcp, persistPlugin, removeMcp, removePlugin } from "./ext-config"
import { installBuiltinSkill, readBuiltinSkill, removeFsInstall, writeAgent, writeSkill } from "./ext-fs-installer"

// GUI apps on macOS launch with a minimal PATH (no Homebrew), so augment it before `which` or we'd
// false-negative tools the user actually has installed.
const PROBE_PATH = [
  process.env.PATH ?? "",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  `${os.homedir()}/.local/bin`,
].join(":")

function checkRuntime(tool: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(tool)) {
      resolve({ ok: false })
      return
    }
    execFile("which", [tool], { env: { ...process.env, PATH: PROBE_PATH } }, (err, stdout) => {
      resolve({ ok: !err && Boolean(stdout && stdout.trim()) })
    })
  })
}

export function registerExtIpcHandlers(userDataPath: string) {
  ipcMain.handle(
    "ext-persist-mcp",
    (_event: IpcMainInvokeEvent, name: string, server: Record<string, unknown>, meta?: InstallMeta, secretVars?: string[]) => {
      // T5:把 requiredEnvVars 的真值(renderer 刚采集,经 IPC 结构化克隆到达此处)搬进
      // {file:} 密钥通道 → durable config 只落引用,绝不明文。renderer 的 live mcp.add 仍用
      // 真值(内存态),下次启动引擎按 {file:} 解析。
      if (secretVars && secretVars.length && server && typeof server === "object") {
        fileifyMcpSecrets(userDataPath, name, server, secretVars)
      }
      return persistMcp(name, server, meta)
    },
  )
  ipcMain.handle("ext-remove-mcp", (_event: IpcMainInvokeEvent, name: string) => {
    removeMcpServerSecrets(userDataPath, name) // revoke the connector's stored secrets on uninstall
    return removeMcp(name)
  })
  // B11/B23:全局配置健康探测(语法错/未知顶键 → 引擎会整份清零)
  ipcMain.handle("ext-config-health", () => configHealth())
  ipcMain.handle("ext-check-runtime", (_event: IpcMainInvokeEvent, tool: string) => checkRuntime(tool))
  ipcMain.handle(
    "ext-write-skill",
    (_event: IpcMainInvokeEvent, name: string, description: string, body: string, target?: InstallTarget) =>
      writeSkill(name, description, body, target),
  )
  ipcMain.handle(
    "ext-write-agent",
    (_event: IpcMainInvokeEvent, name: string, content: string, target?: InstallTarget) =>
      writeAgent(name, content, target),
  )
  ipcMain.handle("ext-install-plugin", (_event: IpcMainInvokeEvent, pkg: string, meta?: InstallMeta) =>
    persistPlugin(pkg, meta),
  )
  ipcMain.handle(
    "ext-install-builtin-skill",
    (_event: IpcMainInvokeEvent, builtinAssetKey: string, name: string, target?: InstallTarget, meta?: InstallMeta) =>
      installBuiltinSkill(builtinAssetKey, name, target, meta),
  )
  // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 体积帽)
  ipcMain.handle("ext-read-builtin-skill", (_event: IpcMainInvokeEvent, builtinAssetKey: string) =>
    readBuiltinSkill(builtinAssetKey),
  )
  // REQ-018 安装账本:合并只读视图(global ~/.alpha + 可选 project .alpha)
  ipcMain.handle("ext-list-installs", (_event: IpcMainInvokeEvent, projectDir?: string) => listInstalls(projectDir))
  // REQ-018 T6:按 receipt 精确卸载(fs 类删文件+拆桥+去账;plugin 从 config[] 删;mcp 走 removeMcp)。
  ipcMain.handle("ext-uninstall", (_event: IpcMainInvokeEvent, receipt: InstallReceipt) => {
    const target: InstallTarget | undefined = receipt.scope === "project" && typeof receipt.configKey !== "string"
      ? undefined // project fs installs pass projectDir via receipt.files[0]'s root — global default otherwise
      : { scope: "global" }
    if (receipt.type === "skill" || receipt.type === "agent") return removeFsInstall(receipt.type, receipt.name, target)
    if (receipt.type === "plugin") {
      const pkg = receipt.configKey?.startsWith("plugin:") ? receipt.configKey.slice("plugin:".length) : receipt.name
      return removePlugin(pkg)
    }
    if (receipt.type === "mcp") {
      removeMcpServerSecrets(userDataPath, receipt.name)
      return removeMcp(receipt.name)
    }
    return { ok: false, reason: `cannot uninstall type: ${receipt.type}` }
  })
  // REQ-018 T3:存量迁移(旧 XDG 根 → .alpha)。scan 报告 + removeLegacy 删旧位;新位由 renderer
  // 复用既有 installer 重装(顺带 A2 钉版 + secret file 化)。用户面触发受 ALPHA_MIGRATE_ENABLE 门控
  // (A6 真机验证后开,S12 T8)。
  ipcMain.handle("ext-migrate-scan", () => ({ enabled: isMigrationEnabled(), inventory: scanLegacy() }))
  ipcMain.handle(
    "ext-migrate-remove-legacy",
    (_event: IpcMainInvokeEvent, type: "skill" | "agent" | "mcp" | "plugin", name: string) => removeLegacy(type, name),
  )
}
