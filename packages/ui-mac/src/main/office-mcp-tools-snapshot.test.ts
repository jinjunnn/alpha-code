// #1565 AC1(REQ-236 §2.3):resources/office-mcp/tools.json 是 server.py 的 tools_for() 在构建期导出的、入库的清单。
// 引擎在文档工具连上之前把它当作这四个工具的声明定义(packages/opencode/src/mcp/alpha-first-party-mcp.ts);它与 server.py
// 一旦不同步,模型拿到的就是错的用法。判据:
//   · 由生产生成脚本重新生成,与入库内容逐字节相等,且生成前后 server.py 的字节不变;
//   · 只改 server.py 里一个 schema 字段,重新生成的工具定义就与入库内容不同(证明比的是 schema,不只是摘要)。
import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OFFICE_MCP_MANIFEST, OFFICE_MCP_SERVER, renderOfficeMcpTools } from "../../scripts/gen-office-mcp-tools"

const scratch = mkdtempSync(join(tmpdir(), "alpha-1565-snapshot-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("AC1: regenerating tools.json from server.py reproduces the committed bytes and leaves server.py untouched", () => {
  const before = sha256(readFileSync(OFFICE_MCP_SERVER))
  expect(renderOfficeMcpTools()).toBe(readFileSync(OFFICE_MCP_MANIFEST, "utf8"))
  expect(sha256(readFileSync(OFFICE_MCP_SERVER))).toBe(before)
})

test("AC1: changing one schema field in server.py changes the exported tool definitions", () => {
  const source = readFileSync(OFFICE_MCP_SERVER, "utf8")
  // write_docx 表格块的 `header` 默认值(Word 段里唯一一处)。
  const field = `"header": {"type": "boolean", "default": True}`
  expect(source.split(field)).toHaveLength(2)
  const edited = join(scratch, "server.py")
  writeFileSync(edited, source.replace(field, `"header": {"type": "boolean", "default": False}`))
  type Manifest = { formats: Record<string, { tools: unknown[] }> }
  const committed = JSON.parse(readFileSync(OFFICE_MCP_MANIFEST, "utf8")) as Manifest
  const regenerated = JSON.parse(renderOfficeMcpTools(edited)) as Manifest
  expect(regenerated.formats.word!.tools).not.toEqual(committed.formats.word!.tools)
  expect(regenerated.formats.excel!.tools).toEqual(committed.formats.excel!.tools)
})
