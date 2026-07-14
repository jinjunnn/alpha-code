// REQ-105 #254:MCP 写盘策略闸口 —— Excel workspace 沙箱强制(fail-closed)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EXCEL_MCP_PIN } from "../shared/office-advisories"
import { excelWorkspaceRoot, persistMcpWithPolicy } from "./ext-mcp-policy"

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

const excelServer = (env?: Record<string, unknown>) => ({
  type: "local",
  command: ["uvx", EXCEL_MCP_PIN.pinnedSpec, "stdio"],
  ...(env ? { environment: env } : {}),
})

describe("persistMcpWithPolicy — Excel workspace sandbox", () => {
  test("main 注入受管 EXCEL_FILES_PATH,覆盖 renderer 提供的越界值", () => {
    const server = excelServer({ EXCEL_FILES_PATH: "/etc" }) as Record<string, unknown>
    const r = persistMcpWithPolicy("excel-mcp-server", server)
    expect(r.ok).toBe(true)
    const managed = fs.realpathSync(excelWorkspaceRoot())
    const env = server.environment as Record<string, unknown>
    expect(env.EXCEL_FILES_PATH).toBe(managed) // 恶意 /etc 被 main 覆盖为受管根
    expect(String(env.EXCEL_FILES_PATH)).toContain(path.join("Alpha", "excel-workspace"))
    expect(fs.statSync(managed).isDirectory()).toBe(true) // 受管根已建立
  })

  test("缺 EXCEL_FILES_PATH 的 Excel server 被注入而非放行(不再 fail-open)", () => {
    const server = excelServer() as Record<string, unknown>
    const r = persistMcpWithPolicy("excel-mcp-server", server)
    expect(r.ok).toBe(true)
    const env = server.environment as Record<string, unknown>
    expect(env.EXCEL_FILES_PATH).toBe(fs.realpathSync(excelWorkspaceRoot()))
  })

  test("Excel server 违反其它不变量(远程 transport)仍 fail-closed", () => {
    const r = persistMcpWithPolicy("excel-mcp-server", { type: "remote", url: "http://0.0.0.0:8017/sse" })
    expect(r.ok).toBe(false)
  })

  test("非 Excel server 透传(零 workspace 干预)", () => {
    const server = { type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"] } as Record<string, unknown>
    const r = persistMcpWithPolicy("markitdown", server)
    expect(r.ok).toBe(true)
    expect(server.environment).toBeUndefined()
  })
})
