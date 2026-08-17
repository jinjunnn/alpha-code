// REQ-105(#197)Excel sandbox 闸口 + archived advisory 匹配的回归锁。纯函数测试 —— 零
// electron / 零 mock.module(Linux CI 泄漏纪律,见 html-preview-host 的 DI 约定;本模块本身无 DI 面)。

import { describe, expect, test } from "bun:test"

import {
  ALPHA_OFFICE_CONNECTORS,
  ARCHIVED_OFFICE_ADVISORIES,
  EXCEL_MCP_PIN,
  alphaOfficeInstallCommand,
  checkAlphaOfficeMcpSafety,
  checkExcelMcpSafety,
  isWorkspacePolicyMcp,
  officeAdvisoryFor,
} from "./office-advisories"

// C 侧 catalog(v2026-07-09.2)上架形状 —— 唯一放行的 Excel 配置基线。
const GOOD_EXCEL = {
  type: "local",
  command: ["uvx", EXCEL_MCP_PIN.pinnedSpec, "stdio"],
} as const

describe("officeAdvisoryFor(archived Word/PPT 匹配)", () => {
  test("按 catalog id 与安装名都能命中;Excel/markitdown 不在归档名单", () => {
    expect(officeAdvisoryFor({ id: "mcp:word" })?.name).toBe("office-word-mcp-server")
    expect(officeAdvisoryFor({ name: "office-powerpoint-mcp-server" })?.catalogId).toBe("mcp:powerpoint")
    // live-but-unrecorded 行:合成 receipt id 是 user:<name>,靠 name 命中
    expect(officeAdvisoryFor({ id: "user:office-word-mcp-server", name: "office-word-mcp-server" })).toBeDefined()
    expect(officeAdvisoryFor({ id: "mcp:excel", name: "excel-mcp-server" })).toBeUndefined()
    expect(officeAdvisoryFor({ id: "mcp:markitdown", name: "markitdown" })).toBeUndefined()
  })

  test("归档记录携带上游归档日期(2026-03-03)——advisory 文案的数据源", () => {
    for (const adv of ARCHIVED_OFFICE_ADVISORIES) {
      expect(adv.kind).toBe("archived")
      expect(adv.archivedAt).toBe("2026-03-03")
    }
  })
})

describe("checkExcelMcpSafety(REQ-105 AC3:拒绝 0.0.0.0 / workspace 外 / 遍历;放行 local stdio)", () => {
  test("放行:目录钉版命令 local stdio(catalog 形状)", () => {
    expect(checkExcelMcpSafety("excel-mcp-server", { ...GOOD_EXCEL })).toEqual({ ok: true })
  })

  test("放行:EXCEL_FILES_PATH 在 workspace 内的绝对路径", () => {
    const r = checkExcelMcpSafety(
      "excel-mcp-server",
      { ...GOOD_EXCEL, environment: { EXCEL_FILES_PATH: "/Users/x/Alpha/books" } },
      "/Users/x/Alpha",
    )
    expect(r).toEqual({ ok: true })
  })

  test("REQ-105 #254:给出策略 workspace 但缺 EXCEL_FILES_PATH → fail-closed(不再放行)", () => {
    // 生产安装路径总会带策略 workspace;此前缺 EXCEL_FILES_PATH 直接放行 = 沙箱 fail-open。
    const r = checkExcelMcpSafety("excel-mcp-server", { ...GOOD_EXCEL }, "/Users/x/Alpha/excel-workspace")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("EXCEL_FILES_PATH")
  })

  test("REQ-105 #254:策略 workspace 下 EXCEL_FILES_PATH 越界 → 拒绝", () => {
    const r = checkExcelMcpSafety(
      "excel-mcp-server",
      { ...GOOD_EXCEL, environment: { EXCEL_FILES_PATH: "/etc" } },
      "/Users/x/Alpha/excel-workspace",
    )
    expect(r.ok).toBe(false)
  })

  test("非 Excel 配置零干预(markitdown / 任意远程连接器原样放行)", () => {
    expect(checkExcelMcpSafety("markitdown", { type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"] })).toEqual({ ok: true })
    expect(checkExcelMcpSafety("some-remote", { type: "remote", url: "https://example.com/mcp" })).toEqual({ ok: true })
  })

  test("拒绝:remote transport(TCP/HTTP,未认证读写前科)", () => {
    const r = checkExcelMcpSafety("excel-mcp-server", { type: "remote", url: "http://0.0.0.0:8017/sse" })
    expect(r.ok).toBe(false)
  })

  test("拒绝:未钉版本 / 版本漂移 / >= 形态(升级必须重新 intake)", () => {
    for (const pkg of ["excel-mcp-server", "excel-mcp-server@0.2.0", "excel-mcp-server>=0.1.8", "excel-mcp-server@latest"]) {
      const r = checkExcelMcpSafety("excel-mcp-server", { type: "local", command: ["uvx", pkg, "stdio"] })
      expect(r.ok, `${pkg} 不应放行`).toBe(false)
    }
  })

  test("拒绝:sse / streamable-http 子命令与缺 stdio", () => {
    for (const cmd of [
      ["uvx", EXCEL_MCP_PIN.pinnedSpec, "sse"],
      ["uvx", EXCEL_MCP_PIN.pinnedSpec, "streamable-http"],
      ["uvx", EXCEL_MCP_PIN.pinnedSpec],
    ]) {
      const r = checkExcelMcpSafety("excel-mcp-server", { type: "local", command: cmd })
      expect(r.ok, `${cmd.join(" ")} 不应放行`).toBe(false)
    }
  })

  test("拒绝:--host/--port 参数与 0.0.0.0 逐字出现(flag= 形态也拦)", () => {
    for (const extra of [["--host", "0.0.0.0"], ["--port", "8017"], ["--host=0.0.0.0"]]) {
      const r = checkExcelMcpSafety("excel-mcp-server", { type: "local", command: [...GOOD_EXCEL.command, ...extra] })
      expect(r.ok, `${extra.join(" ")} 不应放行`).toBe(false)
    }
  })

  test("拒绝:宿主/端口绑定 env(FASTMCP_HOST 等)与 env 值里的 0.0.0.0", () => {
    for (const env of [{ FASTMCP_HOST: "127.0.0.1" }, { FASTMCP_PORT: "8017" }, { SOMETHING: "0.0.0.0" }]) {
      const r = checkExcelMcpSafety("excel-mcp-server", { ...GOOD_EXCEL, environment: env })
      expect(r.ok, `${JSON.stringify(env)} 不应放行`).toBe(false)
    }
  })

  test("拒绝:EXCEL_FILES_PATH 遍历 fixture、相对路径、workspace 外路径", () => {
    const cases: Array<[string, string | undefined]> = [
      ["/Users/x/Alpha/../../etc", undefined], // traversal fixture
      ["books/2026", undefined], // 相对路径
      ["/tmp/elsewhere", "/Users/x/Alpha"], // workspace 外
      ["/Users/x/AlphaEvil", "/Users/x/Alpha"], // 前缀相似但不在边界内
    ]
    for (const [p, ws] of cases) {
      const r = checkExcelMcpSafety("excel-mcp-server", { ...GOOD_EXCEL, environment: { EXCEL_FILES_PATH: p } }, ws)
      expect(r.ok, `${p} (ws=${ws}) 不应放行`).toBe(false)
    }
  })

  test("命令认包不依赖 server 名:改名安装同样被闸口覆盖", () => {
    const r = checkExcelMcpSafety("my-sheets", { type: "local", command: ["uvx", "excel-mcp-server@0.1.7", "stdio"] })
    expect(r.ok).toBe(false)
  })

  test("审计记录形状:版本 0.1.8 + pypi digest 在案(升级必须 bump 此记录)", () => {
    expect(EXCEL_MCP_PIN.version).toBe("0.1.8")
    expect(EXCEL_MCP_PIN.pinnedSpec).toBe(`${EXCEL_MCP_PIN.pypiPackage}@${EXCEL_MCP_PIN.version}`)
    expect(EXCEL_MCP_PIN.sdistSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(EXCEL_MCP_PIN.wheelSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("REQ-133 Alpha Office connector registry and stdio safety", () => {
  const resources = "/Applications/Alpha.app/Contents/Resources"
  const workspace = "/Users/x/Alpha"
  const config = (format: "word" | "excel" | "powerpoint" | "pdf") => ({
    type: "local",
    command: alphaOfficeInstallCommand(format).map((argument) =>
      argument.replace("{alphaResources}", resources).replace("{workspace}", workspace),
    ),
  })

  test("four new ids and exact catalog command arrays are stable", () => {
    expect(ALPHA_OFFICE_CONNECTORS.map((connector) => connector.catalogId)).toEqual([
      "mcp:alpha-word",
      "mcp:alpha-excel",
      "mcp:alpha-powerpoint",
      "mcp:alpha-pdf",
    ])
    expect(alphaOfficeInstallCommand("word")).toEqual([
      "uv", "run", "--no-project", "--with", "python-docx==1.2.0",
      "{alphaResources}/office-mcp/server.py", "word", "{workspace}",
    ])
    expect(alphaOfficeInstallCommand("excel")).toEqual([
      "uv", "run", "--no-project", "--with", "openpyxl==3.1.5",
      "{alphaResources}/office-mcp/server.py", "excel", "{workspace}",
    ])
    expect(alphaOfficeInstallCommand("powerpoint")).toEqual([
      "uv", "run", "--no-project", "--with", "python-pptx==1.0.2",
      "{alphaResources}/office-mcp/server.py", "powerpoint", "{workspace}",
    ])
    expect(alphaOfficeInstallCommand("pdf")).toEqual([
      "uv", "run", "--no-project", "--with", "pypdf==6.16.1", "--with", "reportlab==5.0.0",
      "{alphaResources}/office-mcp/server.py", "pdf", "{workspace}",
    ])
  })

  test("all four exact local commands pass and share the workspace-policy registry", () => {
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      const server = config(connector.format)
      expect(checkAlphaOfficeMcpSafety(connector.name, server, workspace, resources)).toEqual({ ok: true })
      expect(isWorkspacePolicyMcp(connector.name, server)).toBe(true)
    }
    expect(isWorkspacePolicyMcp(EXCEL_MCP_PIN.name, GOOD_EXCEL)).toBe(true)
  })

  test("remote, unpinned, extra transport flags, traversal, and network env fail closed", () => {
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      expect(checkAlphaOfficeMcpSafety(connector.name, { type: "remote", url: "http://127.0.0.1/mcp" }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), command: ["uv", "run", "latest"] }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), command: [...config(connector.format).command, "--host", "0.0.0.0"] }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, config(connector.format), `${workspace}/../etc`, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), environment: { MCP_TRANSPORT: "sse" } }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), environment: { PYTHONPATH: "/tmp/inject" } }, workspace, resources).ok).toBe(false)
    }
  })
})
