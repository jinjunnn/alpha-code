// REQ-133 + REQ-135:MCP 写盘策略闸口 —— Alpha Office 固定命令与社区 Excel 退役。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { WORKSPACE_MARKER, alphaOfficeInstallCommand } from "../shared/office-advisories"
import { aggregateFilesDigest } from "./ext-manifest-v2"
import { BUNDLED_OFFICE_SERVER_PATH, applyMcpWritePolicy, bundledOfficeServerDigest, persistMcpWithPolicy } from "./ext-mcp-policy"

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
  test("main preserves the workspace marker and canonicalizes the bundled server path", () => {
    const server = {
      type: "local",
      command: alphaOfficeInstallCommand("word"),
    } as Record<string, unknown>
    const result = persistMcpWithPolicy("alpha-word", server)
    expect(result.ok).toBe(true)
    const command = server.command as string[]
    expect(command.at(-1)).toBe(WORKSPACE_MARKER)
    expect(command.at(-3)).toBe(fs.realpathSync(path.resolve(import.meta.dir, "../../resources/office-mcp/server.py")))
  })

  test("remote configs and concrete or missing workspace arguments fail closed", () => {
    expect(persistMcpWithPolicy("alpha-word", { type: "remote", url: "http://127.0.0.1/mcp" }).ok).toBe(false)
    const workspace = path.join(tmp, "project")
    fs.mkdirSync(workspace)
    const concrete = {
      type: "local",
      command: alphaOfficeInstallCommand("word").map((argument) => argument.replace("{workspace}", workspace)),
    }
    expect(persistMcpWithPolicy("alpha-word", concrete).ok).toBe(false)
    const missing = path.join(tmp, "missing")
    const server = {
      type: "local",
      command: alphaOfficeInstallCommand("pdf").map((argument) => argument.replace("{workspace}", missing)),
    }
    expect(persistMcpWithPolicy("alpha-pdf", server).ok).toBe(false)
  })
})

// ── REQ-105(#319):策略闸口交出的「执行物 digest」──────────────────────────────────────────
//
// 审计原文(2026-07-14 逐需求审计 · REQ-105):「receipt 记录条目版 1.0.0 而实际执行 0.1.8 且无包
// digest 字段」。今天条目已换成随包的 `mcp:alpha-excel`(卡片版本仍是 1.0.0),形态没变:卡片版本
// 命名连接器,**不命名它执行的字节**。这一组判据钉的就是「那份字节有没有一个可核对的名字」。
//
// 落点选在这里而不是 planner,是因为随包 server.py 的 realpath 本来就只有这道闸口在解 ——
// digest 必须与命令里那个被解出来的路径**同一次**取得,否则中间还留着一个「解的是 A、哈的是 B」
// 的缝。
describe("REQ-105 #319 — bundled Office artifact digest", () => {
  const bundledServer = path.resolve(import.meta.dir, `../../resources/${BUNDLED_OFFICE_SERVER_PATH}`)

  test("a passing Alpha Office verdict carries the content address of the bytes it just canonicalized", () => {
    const server = { type: "local", command: alphaOfficeInstallCommand("excel") } as Record<string, unknown>
    const verdict = applyMcpWritePolicy("alpha-excel", server)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    // 期望值的锚点是**文件字节**,独立于被测代码:sha256 由 node:crypto 现算,不 import 生产的
    // 哈希助手结果、也不抄一个字面量常量。
    const independentFileHash = createHash("sha256").update(fs.readFileSync(bundledServer)).digest("hex")
    expect(verdict.artifactDigest).toBe(
      aggregateFilesDigest([{ path: BUNDLED_OFFICE_SERVER_PATH, sha256: independentFileHash }]),
    )
    // 且它真的**含着**那份字节:换成一个不可能的文件哈希,聚合值必须不同(否则实现可能压根
    // 没读文件,只是返回了一个常量/路径的哈希)。
    expect(verdict.artifactDigest).not.toBe(
      aggregateFilesDigest([{ path: BUNDLED_OFFICE_SERVER_PATH, sha256: "0".repeat(64) }]),
    )
  })

  test("the digest tracks content, not the path — different bytes at the same path differ", () => {
    const a = path.join(tmp, "server-a.py")
    const b = path.join(tmp, "server-b.py")
    fs.writeFileSync(a, "print('a')\n")
    fs.writeFileSync(b, "print('b')\n")
    expect(bundledOfficeServerDigest(a)).not.toBe(bundledOfficeServerDigest(b))
    // 同字节 = 同值(可复现,机器无关):内容地址,不是安装时间戳或随机数。
    const copy = path.join(tmp, "server-a-copy.py")
    fs.copyFileSync(a, copy)
    expect(bundledOfficeServerDigest(copy)).toBe(bundledOfficeServerDigest(a))
    expect(bundledOfficeServerDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("every other MCP reports no artifact digest — absent is 'not recorded', never 'audited'", () => {
    const verdict = applyMcpWritePolicy("markitdown", { type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"] })
    expect(verdict).toEqual({ ok: true })
    expect("artifactDigest" in verdict).toBe(false)
  })

  test("all four Alpha Office connectors report the same bundled artifact (one file, four entry modes)", () => {
    const digests = (["word", "excel", "powerpoint", "pdf"] as const).map((format) => {
      const verdict = applyMcpWritePolicy(`alpha-${format}`, { type: "local", command: alphaOfficeInstallCommand(format) })
      if (!verdict.ok) throw new Error(`${format}: ${verdict.reason}`)
      return verdict.artifactDigest
    })
    expect(new Set(digests).size).toBe(1)
    expect(digests[0]).toBe(bundledOfficeServerDigest(fs.realpathSync(bundledServer)))
  })
})
