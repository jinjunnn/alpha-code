// REQ-105 archived guidance + REQ-135 community Excel retirement + REQ-133 Alpha Office safety.
// Pure-function tests: no Electron and no module mocks.

import { describe, expect, test } from "bun:test"

import {
  ALPHA_OFFICE_CONNECTORS,
  ARCHIVED_OFFICE_ADVISORIES,
  RETIRED_COMMUNITY_OFFICE_CONNECTORS,
  WORKSPACE_MARKER,
  alphaOfficeInstallCommand,
  checkAlphaOfficeMcpSafety,
  isRetiredOfficeMcp,
  isWorkspacePolicyMcp,
  officeAdvisoryFor,
  retiredCommunityOfficeFor,
} from "./office-advisories"

describe("officeAdvisoryFor(archived Word/PPT 匹配)", () => {
  test("按 catalog id 与安装名都能命中;retired community Excel/markitdown 不在归档名单", () => {
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

describe("REQ-135 retired community Office connector identity", () => {
  test("community Excel has one exact retired record; Alpha Excel is a distinct supported identity", () => {
    expect(RETIRED_COMMUNITY_OFFICE_CONNECTORS).toEqual([
      {
        catalogId: "mcp:excel",
        name: "excel-mcp-server",
        pypiPackage: "excel-mcp-server",
        kind: "retired",
      },
    ])
    expect(retiredCommunityOfficeFor({ id: "mcp:excel" })?.name).toBe("excel-mcp-server")
    expect(retiredCommunityOfficeFor({ name: "excel-mcp-server" })?.catalogId).toBe("mcp:excel")
    expect(retiredCommunityOfficeFor({ id: "mcp:alpha-excel", name: "alpha-excel" })).toBeUndefined()
  })

  test("main write-policy detection also catches renamed commands invoking the retired package", () => {
    expect(isRetiredOfficeMcp("excel-mcp-server", { type: "remote", url: "https://example.com/mcp" })).toBe(true)
    for (const pkg of [
      "excel-mcp-server",
      "excel-mcp-server@0.1.8",
      "excel-mcp-server>=0.1.8",
      "excel-mcp-server~=0.1.8",
      "excel-mcp-server[all]==0.1.8",
      "excel-mcp-server;python_version>=\"3.11\"",
      "excel_mcp_server==0.1.8",
      "--from=excel-mcp-server==0.1.8",
      "--with=excel-mcp-server==0.1.8",
      "--with-editable=excel-mcp-server==0.1.8",
      "--with= excel-mcp-server==0.1.8 ",
      " excel-mcp-server==0.1.8 ",
      "excel-mcp-server\t==0.1.8",
      "-w=excel-mcp-server==0.1.8",
      "-wexcel-mcp-server==0.1.8",
      "-qw=excel-mcp-server==0.1.8",
      "-qwexcel-mcp-server==0.1.8",
      "-nwexcel-mcp-server==0.1.8",
    ]) {
      expect(isRetiredOfficeMcp("renamed-sheets", { type: "local", command: ["uvx", pkg, "stdio"] })).toBe(true)
    }
    expect(isRetiredOfficeMcp("alpha-excel", { type: "local", command: alphaOfficeInstallCommand("excel") })).toBe(false)
    expect(isRetiredOfficeMcp("markitdown", { type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"] })).toBe(false)
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
      const marked = {
        ...server,
        command: alphaOfficeInstallCommand(connector.format).map((argument) =>
          argument.replace("{alphaResources}", resources),
        ),
      }
      expect(checkAlphaOfficeMcpSafety(connector.name, marked, WORKSPACE_MARKER, resources)).toEqual({ ok: true })
      expect(isWorkspacePolicyMcp(connector.name, server)).toBe(true)
    }
    expect(isWorkspacePolicyMcp("excel-mcp-server", { type: "local", command: ["uvx", "excel-mcp-server@0.1.8", "stdio"] })).toBe(false)
  })

  test("remote, unpinned, extra transport flags, traversal, and network env fail closed", () => {
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      expect(checkAlphaOfficeMcpSafety(connector.name, { type: "remote", url: "http://127.0.0.1/mcp" }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), command: ["uv", "run", "latest"] }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), command: [...config(connector.format).command, "--host", "0.0.0.0"] }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, config(connector.format), `${workspace}/../etc`, resources).ok).toBe(false)
      expect(
        checkAlphaOfficeMcpSafety(
          connector.name,
          {
            ...config(connector.format),
            command: alphaOfficeInstallCommand(connector.format).map((argument) =>
              argument.replace("{alphaResources}", resources).replace("{workspace}", "prefix-{workspace}"),
            ),
          },
          "prefix-{workspace}",
          resources,
        ).ok,
      ).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), environment: { MCP_TRANSPORT: "sse" } }, workspace, resources).ok).toBe(false)
      expect(checkAlphaOfficeMcpSafety(connector.name, { ...config(connector.format), environment: { PYTHONPATH: "/tmp/inject" } }, workspace, resources).ok).toBe(false)
    }
  })
})
