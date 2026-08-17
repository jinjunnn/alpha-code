import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { alphaOfficeInstallCommand, type AlphaOfficeFormat } from "../shared/office-advisories"

const server = resolve(import.meta.dir, "../../resources/office-mcp/server.py")
const uv = Bun.which("uv")
const python = Bun.which("python3")
const testPython = test.skipIf(!python)
const enabledFormats = new Set((process.env.ALPHA_OFFICE_MCP_TEST_FORMATS ?? "word,excel,powerpoint,pdf").split(","))
const testFormat = (format: AlphaOfficeFormat) => test.skipIf(!uv || !enabledFormats.has(format))
let workspace: string

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "alpha-office-mcp-"))
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

type ResponseMessage = {
  id: number
  result?: {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
    tools?: Array<{ name: string }>
  }
  error?: { code: number; message: string }
}

async function exchange(command: string[], requests: unknown[]) {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`)
  child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`office MCP exited ${exitCode}: ${stderr}`)
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResponseMessage)
}

function commandFor(format: AlphaOfficeFormat) {
  return alphaOfficeInstallCommand(format).map((argument) =>
    argument.replace("{alphaResources}/office-mcp/server.py", server).replace("{workspace}", workspace),
  )
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
}

function payload(messages: ResponseMessage[], id: number) {
  const response = messages.find((message) => message.id === id)
  expect(response?.result?.isError).not.toBe(true)
  const text = response?.result?.content?.[0]?.text
  if (!text) throw new Error(`missing tool payload for id ${id}: ${JSON.stringify(response)}`)
  return JSON.parse(text) as Record<string, unknown>
}

describe("REQ-133 Alpha first-party Office MCP resources", () => {
  testFormat("word")(
    "Word creates and reads docx without Microsoft Word",
    async () => {
      const path = join(workspace, "report.docx")
      const messages = await exchange(commandFor("word"), [
        initialize(),
        call(2, "write_docx", { path, title: "Alpha", paragraphs: ["First paragraph", "Second paragraph"] }),
        call(3, "read_docx", { path }),
      ])
      expect(payload(messages, 2).paragraphsWritten).toBe(2)
      expect(payload(messages, 3).paragraphs).toEqual(["Alpha", "First paragraph", "Second paragraph"])
    },
    180_000,
  )

  testFormat("excel")(
    "Excel creates and reads xlsx without Microsoft Excel",
    async () => {
      const path = join(workspace, "book.xlsx")
      const messages = await exchange(commandFor("excel"), [
        initialize(),
        call(2, "write_xlsx", {
          path,
          sheets: [{ name: "Data", cells: { A1: "Item", B1: "Value", A2: "Alpha", B2: 133 } }],
        }),
        call(3, "read_xlsx", { path }),
      ])
      expect(payload(messages, 2).sheetsUpdated).toEqual(["Data"])
      expect(payload(messages, 3).sheets).toEqual([
        {
          name: "Data",
          rows: [
            ["Item", "Value"],
            ["Alpha", 133],
          ],
        },
      ])
    },
    180_000,
  )

  testFormat("powerpoint")(
    "PowerPoint creates and reads pptx without Microsoft PowerPoint",
    async () => {
      const path = join(workspace, "deck.pptx")
      const messages = await exchange(commandFor("powerpoint"), [
        initialize(),
        call(2, "write_pptx", { path, slides: [{ title: "REQ-133", body: ["Alpha", "PowerPoint"] }] }),
        call(3, "read_pptx", { path }),
      ])
      expect(payload(messages, 2).slidesWritten).toBe(1)
      expect(payload(messages, 3).slides).toEqual([{ number: 1, text: ["REQ-133", "Alpha\nPowerPoint"] }])
    },
    180_000,
  )

  testFormat("pdf")(
    "PDF creates, appends, and reads text pages without a layout designer",
    async () => {
      const path = join(workspace, "report.pdf")
      const messages = await exchange(commandFor("pdf"), [
        initialize(),
        call(2, "write_pdf", { path, pages: ["First page"] }),
        call(3, "write_pdf", { path, pages: ["Appended page"], mode: "append" }),
        call(4, "read_pdf", { path }),
      ])
      expect(payload(messages, 2).mode).toBe("replace")
      expect(payload(messages, 3).mode).toBe("append")
      expect(payload(messages, 4).pages).toEqual([
        expect.stringContaining("First page"),
        expect.stringContaining("Appended page"),
      ])
    },
    180_000,
  )

  testPython("absolute paths with traversal segments are rejected before format code runs", async () => {
    const path = `${workspace}/nested/../escape.docx`
    const messages = await exchange(
      [python!, server, "word", workspace],
      [initialize(), call(2, "read_docx", { path })],
    )
    const response = messages.find((message) => message.id === 2)
    expect(response?.result?.isError).toBe(true)
    expect(response?.result?.content?.[0]?.text).toContain("path traversal")
  })

  testPython("four stdio entry modes expose only their format-specific read/write tools", async () => {
    const expected = {
      word: ["read_docx", "write_docx"],
      excel: ["read_xlsx", "write_xlsx"],
      powerpoint: ["read_pptx", "write_pptx"],
      pdf: ["read_pdf", "write_pdf"],
    } as const
    for (const format of Object.keys(expected) as AlphaOfficeFormat[]) {
      const messages = await exchange(
        [python!, server, format, workspace],
        [initialize(), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
      )
      expect(messages.find((message) => message.id === 2)?.result?.tools?.map((tool) => tool.name)).toEqual(
        expected[format],
      )
    }
  })

  testPython("server CLI has no network transport, host, port, or SSE flags", () => {
    for (const extra of [["sse"], ["--host", "0.0.0.0"], ["--port", "8017"], ["--transport", "streamable-http"]]) {
      const result = Bun.spawnSync([python!, server, "word", workspace, ...extra])
      expect(result.exitCode, extra.join(" ")).not.toBe(0)
      expect(result.stderr.toString()).toContain("stdio is the only transport")
    }
  })
})
