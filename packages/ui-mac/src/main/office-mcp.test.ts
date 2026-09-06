import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { alphaOfficeInstallCommand, type AlphaOfficeFormat } from "../shared/office-advisories"

const server = resolve(import.meta.dir, "../../resources/office-mcp/server.py")
const uv = Bun.which("uv")
const python = Bun.which("python3")
const enabledFormats = new Set(
  (process.env.ALPHA_OFFICE_MCP_TEST_FORMATS ?? "word,excel,powerpoint,pdf")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
)
const testFormat = (format: AlphaOfficeFormat) => test.skipIf(!enabledFormats.has(format))
let workspace: string

beforeAll(() => {
  if (!python) throw new Error("本次测量作废: office-mcp tests require python3 on PATH (missing toolchain must not skip-green)")
  if (!uv) throw new Error("本次测量作废: office-mcp tests require uv on PATH (missing toolchain must not skip-green)")
  if (enabledFormats.size === 0) {
    throw new Error("本次测量作废: ALPHA_OFFICE_MCP_TEST_FORMATS is empty")
  }
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

function refusal(messages: ResponseMessage[], id: number) {
  const response = messages.find((message) => message.id === id)
  expect(response?.result?.isError, `id ${id} must be an explicit refusal: ${JSON.stringify(response)}`).toBe(true)
  return response?.result?.content?.[0]?.text ?? ""
}

/** #1245:判据读的是产物本身(解包 OOXML),不是工具返回值 —— 上一轮的教训正是「返回成功而产物里一个字段都没有」。 */
function ooxmlPart(file: string, part: string) {
  const result = Bun.spawnSync([
    python!,
    "-c",
    "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode('utf-8'))",
    file,
    part,
  ])
  if (result.exitCode !== 0) throw new Error(`cannot read ${part} from ${file}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** 三项事实的判官(与 VERIFY 子票同一口径):eastAsia 非空 / 标题段带 Heading pStyle / sectPr A4。 */
function docxFacts(file: string, headingText: string) {
  const theme = ooxmlPart(file, "word/theme/theme1.xml")
  const styles = ooxmlPart(file, "word/styles.xml")
  const document = ooxmlPart(file, "word/document.xml")
  const eastAsiaTypefaces = [...theme.matchAll(/<a:ea typeface="([^"]*)"/g)].map((match) => match[1])
  const docDefaults = /<w:docDefaults>.*?<\/w:docDefaults>/s.exec(styles)?.[0] ?? ""
  const docDefaultsEastAsia = /<w:rFonts[^>]*\bw:eastAsia="([^"]*)"/.exec(docDefaults)?.[1] ?? null
  const headingParagraph = [...document.matchAll(/<w:p\b.*?<\/w:p>/gs)]
    .map((match) => match[0])
    .find((paragraph) => paragraph.replace(/<[^>]+>/g, "").includes(headingText))
  const headingStyle = headingParagraph ? (/<w:pStyle w:val="([^"]*)"/.exec(headingParagraph)?.[1] ?? "Normal") : null
  const pageSize = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(document)
  return {
    eastAsiaTypefaces,
    docDefaultsEastAsia,
    headingStyle,
    pageSize: pageSize ? [Number(pageSize[1]), Number(pageSize[2])] : null,
    tables: document.split("<w:tbl>").length - 1,
    created: /<dcterms:created[^>]*>([^<]*)</.exec(ooxmlPart(file, "docProps/core.xml"))?.[1] ?? null,
  }
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

  testFormat("word")(
    "write_docx refuses undeclared arguments instead of silently dropping them, and leaves no file behind",
    async () => {
      const refused = join(workspace, "refused.docx")
      const messages = await exchange(commandFor("word"), [
        initialize(),
        // 票面现状:多传 font/size 曾被收下并返回成功(产物零 rPr)。
        call(2, "write_docx", { path: refused, paragraphs: ["x"], font: "宋体", size: 12 }),
        call(3, "write_docx", { path: refused, paragraphs: ["x"], page: { size: "A4", color: "red" } }),
        call(4, "write_docx", { path: refused, paragraphs: ["x"], font: { eastAsia: "宋体", weight: "bold" } }),
        call(5, "write_docx", { path: refused, paragraphs: [{ type: "heading", text: "x", level: 10 }] }),
        call(6, "write_docx", { path: refused, paragraphs: [{ type: "table", rows: [["a", "b"], ["c"]] }] }),
        call(7, "write_docx", { path: refused, paragraphs: [{ type: "image", src: "x.png" }] }),
        call(8, "write_docx", { path: refused, paragraphs: ["x"], page: { size: "B5" } }),
      ])
      expect(refusal(messages, 2)).toContain("does not accept: size")
      expect(refusal(messages, 2)).toContain("accepted: append, font, page, paragraphs, path, title")
      expect(refusal(messages, 3)).toContain("page does not accept: color")
      expect(refusal(messages, 4)).toContain("font does not accept: weight")
      expect(refusal(messages, 5)).toContain("level must be an integer from 1 to 9")
      expect(refusal(messages, 6)).toContain("rows must be rectangular")
      expect(refusal(messages, 7)).toContain("type must be paragraph, heading, or table")
      expect(refusal(messages, 8)).toContain("page.size must be one of A4, Letter")
      expect(existsSync(refused)).toBe(false)
    },
    180_000,
  )

  testFormat("word")(
    "write_docx product carries an East Asian font, real heading styles, A4 geometry and a table (read back from OOXML)",
    async () => {
      // 先证明判官测得出已知的坏:裸 python-docx 模板(= 旧 server 的产物形状)eastAsia 为空、US Letter、created=2013。
      const control = join(workspace, "control.docx")
      const bare = Bun.spawnSync(
        ["uv", "run", "--no-project", "--with", "python-docx==1.2.0", "python", "-c", "import sys; from docx import Document; d = Document(); d.add_paragraph('一、总体情况'); d.save(sys.argv[1])", control],
        { env: process.env },
      )
      if (bare.exitCode !== 0) throw new Error(`本次测量作废: control docx not produced: ${bare.stderr.toString()}`)
      const controlFacts = docxFacts(control, "一、总体情况")
      expect(controlFacts.eastAsiaTypefaces).toEqual(["", ""])
      expect(controlFacts.docDefaultsEastAsia).toBeNull()
      expect(controlFacts.headingStyle).toBe("Normal")
      expect(controlFacts.pageSize).toEqual([12240, 15840])
      expect(controlFacts.created?.startsWith("2013-")).toBe(true)

      const path = join(workspace, "recon.docx")
      const messages = await exchange(commandFor("word"), [
        initialize(),
        call(2, "write_docx", {
          path,
          title: "调研报告",
          paragraphs: [
            { type: "heading", text: "一、总体情况", level: 1 },
            "正文中文段落。",
            { type: "heading", text: "1.1 细分", level: 2 },
            { type: "paragraph", text: "第二段" },
            { type: "table", rows: [["项目", "数值"], ["甲", "1"]] },
          ],
        }),
        call(3, "read_docx", { path }),
      ])
      expect(payload(messages, 2)).toMatchObject({
        paragraphsWritten: 2,
        headingsWritten: 2,
        tablesWritten: 1,
        appended: false,
        page: { size: "A4", orientation: "portrait", marginsMm: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 } },
        font: { eastAsia: "宋体" },
      })
      // path 由 server 解析成 realpath(macOS 的 tmpdir 是 /var → /private/var 的链),只比内容。
      expect(payload(messages, 3)).toMatchObject({
        paragraphs: ["调研报告", "一、总体情况", "正文中文段落。", "1.1 细分", "第二段"],
        tables: [[["项目", "数值"], ["甲", "1"]]],
      })

      const facts = docxFacts(path, "一、总体情况")
      expect(facts.eastAsiaTypefaces).toEqual(["宋体", "宋体"]) // major + minor
      expect(facts.docDefaultsEastAsia).toBe("宋体")
      expect(facts.headingStyle).toBe("Heading1")
      expect(docxFacts(path, "1.1 细分").headingStyle).toBe("Heading2")
      expect(docxFacts(path, "调研报告").headingStyle).toBe("Title")
      expect(docxFacts(path, "正文中文段落。").headingStyle).toBe("Normal")
      expect(facts.pageSize).toEqual([11906, 16838])
      expect(facts.tables).toBe(1)
      expect(facts.created?.startsWith("2013-")).toBe(false)
      const document = ooxmlPart(path, "word/document.xml")
      expect(document).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"')
      expect(document).toContain('<w:tblStyle w:val="TableGrid"/>')
      expect(document.split("<w:tr").length - 1).toBe(2)
      const styles = ooxmlPart(path, "word/styles.xml")
      expect(styles).not.toMatch(/<w:docDefaults>.*w:eastAsiaTheme=.*<\/w:docDefaults>/s)
      expect(styles).toMatch(/<w:docDefaults>.*<w:lang [^>]*w:eastAsia="zh-CN".*<\/w:docDefaults>/s)
    },
    180_000,
  )

  testFormat("word")(
    "write_docx honours explicit page (Letter landscape, margins) and fonts, and append leaves geometry alone unless asked",
    async () => {
      const path = join(workspace, "letter.docx")
      const messages = await exchange(commandFor("word"), [
        initialize(),
        call(2, "write_docx", {
          path,
          paragraphs: ["Landscape"],
          page: { size: "Letter", orientation: "landscape", margins: { top: 20, bottom: 20, left: 20, right: 20 } },
          font: { eastAsia: "黑体", latin: "Times New Roman", size: 12 },
        }),
        call(3, "write_docx", { path, paragraphs: [{ type: "heading", text: "二、追加", level: 1 }], append: true }),
        call(4, "read_docx", { path }),
      ])
      expect(payload(messages, 2)).toMatchObject({
        page: { size: "Letter", orientation: "landscape", marginsMm: { top: 20, bottom: 20, left: 20, right: 20 } },
        font: { eastAsia: "黑体", latin: "Times New Roman", size: 12 },
      })
      expect(payload(messages, 3)).toMatchObject({ appended: true, headingsWritten: 1, page: null, font: null })
      expect(payload(messages, 4).paragraphs).toEqual(["Landscape", "二、追加"])

      const document = ooxmlPart(path, "word/document.xml")
      expect(document).toContain('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
      expect(document).toContain('<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"')
      const facts = docxFacts(path, "二、追加")
      expect(facts.eastAsiaTypefaces).toEqual(["黑体", "黑体"])
      expect(facts.headingStyle).toBe("Heading1")
      const theme = ooxmlPart(path, "word/theme/theme1.xml")
      expect([...theme.matchAll(/<a:latin typeface="([^"]*)"/g)].map((match) => match[1])).toEqual(["Times New Roman", "Times New Roman"])
      const styles = ooxmlPart(path, "word/styles.xml")
      const docDefaults = /<w:docDefaults>.*?<\/w:docDefaults>/s.exec(styles)?.[0] ?? ""
      expect(docDefaults).toContain('w:eastAsia="黑体"')
      expect(docDefaults).toContain('w:ascii="Times New Roman"')
      expect(docDefaults).toContain('w:hAnsi="Times New Roman"')
      expect(docDefaults).not.toContain("w:asciiTheme")
      expect(docDefaults).toContain('<w:sz w:val="24"/>')
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

  test("absolute paths with traversal segments are rejected before format code runs", async () => {
    const path = `${workspace}/nested/../escape.docx`
    const messages = await exchange(
      [python!, server, "word", workspace],
      [initialize(), call(2, "read_docx", { path })],
    )
    const response = messages.find((message) => message.id === 2)
    expect(response?.result?.isError).toBe(true)
    expect(response?.result?.content?.[0]?.text).toContain("path traversal")
  })

  test("absolute paths outside the granted workspace are rejected before format code runs", async () => {
    const messages = await exchange(
      [python!, server, "word", workspace],
      [initialize(), call(2, "read_docx", { path: join(dirname(workspace), "outside.docx") })],
    )
    const response = messages.find((message) => message.id === 2)
    expect(response?.result?.isError).toBe(true)
    expect(response?.result?.content?.[0]?.text).toContain("path is outside the granted workspace")
  })

  test("four stdio entry modes expose only their format-specific read/write tools", async () => {
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

  test("server CLI has no network transport, host, port, or SSE flags", () => {
    for (const extra of [["sse"], ["--host", "0.0.0.0"], ["--port", "8017"], ["--transport", "streamable-http"]]) {
      const result = Bun.spawnSync([python!, server, "word", workspace, ...extra])
      expect(result.exitCode, extra.join(" ")).not.toBe(0)
      expect(result.stderr.toString()).toContain("stdio is the only transport")
    }
  })
})
