// Extension Hub IPC handlers (main process). Mirrors ipc.ts's ipcMain.handle pattern. Three thin
// privileged operations the renderer can't do itself: persist/remove an MCP server in the user
// config (ext-config.ts), and a runtime which-check so the UI can warn before adding a local MCP
// whose binary (uv/node/…) is missing. All validation lives in ext-config / here — see ADR-014 §8.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as os from "node:os"
import { persistMcp, persistPlugin, removeMcp } from "./ext-config"
import { writeAgent, writeSkill } from "./ext-fs-installer"

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

export function registerExtIpcHandlers() {
  ipcMain.handle("ext-persist-mcp", (_event: IpcMainInvokeEvent, name: string, server: Record<string, unknown>) =>
    persistMcp(name, server),
  )
  ipcMain.handle("ext-remove-mcp", (_event: IpcMainInvokeEvent, name: string) => removeMcp(name))
  ipcMain.handle("ext-check-runtime", (_event: IpcMainInvokeEvent, tool: string) => checkRuntime(tool))
  ipcMain.handle(
    "ext-write-skill",
    (_event: IpcMainInvokeEvent, name: string, description: string, body: string) =>
      writeSkill(name, description, body),
  )
  ipcMain.handle("ext-write-agent", (_event: IpcMainInvokeEvent, name: string, content: string) =>
    writeAgent(name, content),
  )
  ipcMain.handle("ext-install-plugin", (_event: IpcMainInvokeEvent, pkg: string) => persistPlugin(pkg))
}
