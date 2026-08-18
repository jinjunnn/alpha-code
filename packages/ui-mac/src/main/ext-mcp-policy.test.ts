// REQ-133 + REQ-135:MCP 写盘策略闸口 —— Alpha Office 固定命令与社区 Excel 退役。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { alphaOfficeInstallCommand } from "../shared/office-advisories"
import { applyMcpWritePolicy, persistMcpWithPolicy } from "./ext-mcp-policy"

let tmp: string
let prevWorkspace: string | undefined
let prevGlobal: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-mcp-policy-"))
  prevWorkspace = process.env.ALPHA_USER_WORKSPACE_DIR
  prevGlobal = process.env.ALPHA_GLOBAL_DIR
  process.env.ALPHA_USER_WORKSPACE_DIR = path.join(tmp, "Alpha")
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "dot-alpha")
})

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.ALPHA_USER_WORKSPACE_DIR
  else process.env.ALPHA_USER_WORKSPACE_DIR = prevWorkspace
  if (prevGlobal === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevGlobal
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("persistMcpWithPolicy — REQ-135 community Excel retirement", () => {
  test.each([
    ["excel-mcp-server", ["uvx", "excel-mcp-server@0.1.8", "stdio"]],
    ["renamed-sheets", ["uvx", "excel-mcp-server@0.1.8", "stdio"]],
    ["renamed-sheets", ["uv", "run", "--with=excel-mcp-server==0.1.8", "server.py"]],
    ["renamed-sheets", ["uv", "run", "-wexcel-mcp-server==0.1.8", "server.py"]],
    ["renamed-sheets", ["uv", "run", "-qwexcel-mcp-server==0.1.8", "server.py"]],
    ["renamed-sheets", ["uv", "run", "--with", " excel-mcp-server==0.1.8 ", "server.py"]],
  ])("retired community Excel is denied by direct or renamed package identity (%s)", (name, command) => {
    expect(persistMcpWithPolicy(name, { type: "local", command }).ok).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dot-alpha", "alpha.jsonc"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "Alpha", "excel-workspace"))).toBe(false)
  })

  test("ordinary MCP passthrough does not mutate its environment or provision the retired workspace", () => {
    const environment = { KEEP_ME: "yes" }
    const server = {
      type: "local",
      command: ["uvx", "markitdown-mcp@0.0.1a4"],
      environment,
    } as Record<string, unknown>

    expect(applyMcpWritePolicy("markitdown", server)).toEqual({ ok: true })
    expect(server.environment).toBe(environment)
    expect(environment).toEqual({ KEEP_ME: "yes" })
    expect(fs.existsSync(path.join(tmp, "Alpha", "excel-workspace"))).toBe(false)
  })
})

describe("persistMcpWithPolicy — REQ-133 Alpha Office workspace sandbox", () => {
  test("main canonicalizes the granted workspace and bundled server path", () => {
    const workspace = path.join(tmp, "project")
    fs.mkdirSync(workspace)
    const server = {
      type: "local",
      command: alphaOfficeInstallCommand("word").map((argument) => argument.replace("{workspace}", workspace)),
    } as Record<string, unknown>
    const result = persistMcpWithPolicy("alpha-word", server)
    expect(result.ok).toBe(true)
    const command = server.command as string[]
    expect(command.at(-1)).toBe(fs.realpathSync(workspace))
    expect(command.at(-3)).toBe(fs.realpathSync(path.resolve(import.meta.dir, "../../resources/office-mcp/server.py")))
  })

  test("remote configs and missing workspace grants fail closed", () => {
    expect(persistMcpWithPolicy("alpha-word", { type: "remote", url: "http://127.0.0.1/mcp" }).ok).toBe(false)
    const missing = path.join(tmp, "missing")
    const server = {
      type: "local",
      command: alphaOfficeInstallCommand("pdf").map((argument) => argument.replace("{workspace}", missing)),
    }
    expect(persistMcpWithPolicy("alpha-pdf", server).ok).toBe(false)
  })
})
