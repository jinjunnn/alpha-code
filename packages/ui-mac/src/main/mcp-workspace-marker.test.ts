import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import {
  ALPHA_OFFICE_CONNECTORS,
  WORKSPACE_MARKER,
  alphaOfficeInstallCommand,
  type AlphaOfficeFormat,
} from "../shared/office-advisories"
import { reconcileMcpWorkspaceMarkers, restoreWorkspaceMarker } from "./mcp-workspace-marker"

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "alpha-mcp-marker-"))
  roots.push(root)
  return root
}

function officeCommand(format: AlphaOfficeFormat, server: string, workspace: string) {
  return alphaOfficeInstallCommand(format).map((argument) => {
    if (argument === "{alphaResources}/office-mcp/server.py") return server
    if (argument === WORKSPACE_MARKER) return workspace
    return argument
  })
}

function receipt(id: string, name: string, origin = "catalog", configKey = `mcp.${name}`) {
  return {
    id,
    name,
    type: "mcp",
    scope: "global",
    installedAt: "2026-08-17T12:00:00.000Z",
    origin,
    configKey,
  }
}

function writeLedger(root: string, receipts: unknown[]) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "installs.json"), JSON.stringify({ v: 1, receipts }, null, 2))
}

function writeConfig(file: string, mcp: Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `// retained comment\n${JSON.stringify({ mcp }, null, 2)}\n`)
}

function readConfig(file: string) {
  return parse(readFileSync(file, "utf8")) as { mcp: Record<string, { command: string[] }> }
}

describe("restoreWorkspaceMarker", () => {
  test("restores the exact workspace slot for all six catalog templates", () => {
    const server = "/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py"
    const workspace = "/Users/example/project"
    const cases = [
      {
        id: "mcp:filesystem",
        name: "filesystem",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", workspace],
      },
      {
        id: "mcp:git",
        name: "git",
        command: ["uvx", "mcp-server-git@2026.6.16", "--repository", workspace],
      },
      ...ALPHA_OFFICE_CONNECTORS.map((connector) => ({
        id: connector.catalogId,
        name: connector.name,
        command: officeCommand(connector.format, server, workspace),
      })),
    ]

    cases.forEach((item) => {
      const restored = restoreWorkspaceMarker(item.id, item.name, item.command, server)
      expect(restored?.at(-1), item.id).toBe(WORKSPACE_MARKER)
      expect(restored?.slice(0, -1), item.id).toEqual(item.command.slice(0, -1))
    })
  })

  test("refuses version/resource drift, extra argv, relative paths, marker substrings, and custom identity", () => {
    const workspace = "/Users/example/project"
    const server = "/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py"
    expect(
      restoreWorkspaceMarker("mcp:filesystem", "filesystem", [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem@latest",
        workspace,
      ]),
    ).toBeNull()
    expect(
      restoreWorkspaceMarker("mcp:git", "git", [
        "uvx",
        "mcp-server-git@2026.6.16",
        "--repository",
        workspace,
        "--verbose",
      ]),
    ).toBeNull()
    expect(
      restoreWorkspaceMarker("mcp:git", "git", ["uvx", "mcp-server-git@2026.6.16", "--repository", "relative/project"]),
    ).toBeNull()
    expect(
      restoreWorkspaceMarker("mcp:git", "git", ["uvx", "mcp-server-git@2026.6.16", "--repository", "/tmp/{workspace}"]),
    ).toBeNull()
    expect(
      restoreWorkspaceMarker("user:filesystem", "filesystem", [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem@2026.1.14",
        workspace,
      ]),
    ).toBeNull()
    expect(
      restoreWorkspaceMarker(
        "mcp:alpha-word",
        "alpha-word",
        officeCommand("word", "/Applications/old-alpha.app/Contents/Resources/office-mcp/server.py", workspace),
        server,
      ),
    ).toBeNull()
  })
})

describe("reconcileMcpWorkspaceMarkers", () => {
  test("migrates the six exact catalog-owned commands and is byte-idempotent", () => {
    const root = tempRoot()
    const config = join(root, "alpha.jsonc")
    const server = join(root, "resources", "office-mcp", "server.py")
    const workspace = join(root, "old-project")
    const office = Object.fromEntries(
      ALPHA_OFFICE_CONNECTORS.map((connector) => [
        connector.name,
        { type: "local", command: officeCommand(connector.format, server, workspace), timeout: 5_000 },
      ]),
    )
    writeConfig(config, {
      filesystem: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", workspace],
      },
      git: {
        type: "local",
        command: ["uvx", "mcp-server-git@2026.6.16", "--repository", workspace],
      },
      ...office,
    })
    writeLedger(root, [
      receipt("mcp:filesystem", "filesystem"),
      receipt("mcp:git", "git"),
      ...ALPHA_OFFICE_CONNECTORS.map((connector) => receipt(connector.catalogId, connector.name)),
    ])

    const first = reconcileMcpWorkspaceMarkers({
      configPath: config,
      ledgerRoot: root,
      alphaOfficeServerPath: server,
    })

    expect(first).toEqual({
      migrated: ["filesystem", "git", ...ALPHA_OFFICE_CONNECTORS.map((connector) => connector.name)],
      warnings: [],
    })
    Object.values(readConfig(config).mcp).forEach((entry) => expect(entry.command.at(-1)).toBe(WORKSPACE_MARKER))
    expect(readFileSync(config, "utf8")).toContain("// retained comment")

    const afterFirst = readFileSync(config, "utf8")
    expect(
      reconcileMcpWorkspaceMarkers({
        configPath: config,
        ledgerRoot: root,
        alphaOfficeServerPath: server,
      }),
    ).toEqual({ migrated: [], warnings: [] })
    expect(readFileSync(config, "utf8")).toBe(afterFirst)
  })

  test("leaves custom-owned, custom-name, drifted, and community Excel commands untouched", () => {
    const root = tempRoot()
    const config = join(root, "alpha.jsonc")
    const workspace = join(root, "old-project")
    const original = {
      filesystem: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", workspace],
      },
      git: {
        type: "local",
        command: ["uvx", "mcp-server-git@latest", "--repository", workspace],
      },
      custom: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", workspace],
      },
      "excel-mcp-server": {
        type: "local",
        command: ["uvx", "excel-mcp-server@0.1.8", "stdio"],
        environment: { EXCEL_FILES_PATH: workspace },
      },
    }
    writeConfig(config, original)
    writeLedger(root, [
      receipt("user:filesystem", "filesystem", "created"),
      receipt("mcp:git", "git"),
      receipt("mcp:filesystem", "custom"),
      receipt("mcp:excel", "excel-mcp-server"),
    ])
    const before = readFileSync(config, "utf8")

    expect(reconcileMcpWorkspaceMarkers({ configPath: config, ledgerRoot: root })).toEqual({
      migrated: [],
      warnings: [],
    })
    expect(readFileSync(config, "utf8")).toBe(before)
  })

  test("requires the catalog receipt to own the exact MCP config key", () => {
    const root = tempRoot()
    const config = join(root, "alpha.jsonc")
    writeConfig(config, {
      filesystem: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", join(root, "old-project")],
      },
    })
    writeLedger(root, [receipt("mcp:filesystem", "filesystem", "catalog", "mcp.other")])
    const before = readFileSync(config, "utf8")

    expect(reconcileMcpWorkspaceMarkers({ configPath: config, ledgerRoot: root })).toEqual({
      migrated: [],
      warnings: [],
    })
    expect(readFileSync(config, "utf8")).toBe(before)
  })

  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): main runs marker reconciliation before the first sidecar fork", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    const timeoutReconcile = source.indexOf("  ensureGovernedMcpConnectTimeouts()")
    const markerReconcile = source.indexOf("  reconcileMcpWorkspaceMarkers()")
    const firstFork = source.indexOf("spawnLocalServer(hostname, port, password")

    expect(timeoutReconcile).toBeGreaterThan(-1)
    expect(markerReconcile).toBeGreaterThan(timeoutReconcile)
    expect(firstFork).toBeGreaterThan(markerReconcile)
  })
})
