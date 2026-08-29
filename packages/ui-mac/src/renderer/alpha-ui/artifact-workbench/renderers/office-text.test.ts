// REQ-123(#1175)— docx / pptx 提取器测试:真实产生器夹具字节 → 内容串断言。
// 判据(票面退出条件):内容串出现,Cocoa 与 python-docx 两种产物都过;pptx 多页断言
// 权威页序;「全部文本串成一坨无页界」或「按文件名排序」的错误实现在页结构断言上红。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { docxTextModelOf, pptxTextModelOf, type OfficeTextModel } from "./office-text"

GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const FIXTURES = join(import.meta.dir, "fixtures/office-text")

// ---------------------------------------------------------------------------
// 临时解析辅助 —— 只服务测试,不是生产 API。
// 接线时(#1174)替换为共享的「字节→Document」安全解析函数(解码 + DOCTYPE/ENTITY 文本闸
// + parseFromString);本辅助刻意保持同一形状(bytes 进、Document 出)。
//
// happy-dom 20.9 已探明缺陷(本票勘破,3 组探针实测):当同一元素上存在 localName 相同的
// 两个属性且未加前缀者在前(真实 presentation.xml 的 `<p:sldId id=".." r:id="..">`),
// 解析期直接丢弃后者,r:id 不可恢复;Chromium 无此问题。下面的换序对 XML infoset 等价
// (属性序无语义),只为让测试 DOM 保住 Chromium 本来就有的属性;pptx 用例里有正对照
// 断言(每个 sldId 的 r:id 都解析得出),换序失手时用例翻红而不是静默变假。
// ---------------------------------------------------------------------------
function parseXmlPartForTest(bytes: Uint8Array): Document {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  // happy-dom 缺陷之二(实测):XML 声明里的单引号(lxml 产物)被拒为 parsererror,
  // Chromium 接受(合法 XML)。只在声明内做引号归一,infoset 等价。
  text = text.replace(/^<\?xml[^?]*\?>/, (declaration) => declaration.replaceAll("'", '"'))
  text = text.replace(/<p:sldId id="([^"]+)" r:id="([^"]+)"/g, '<p:sldId r:id="$2" id="$1"')
  const parsed = new DOMParser().parseFromString(text, "application/xml") as unknown as Document
  expect(parsed.getElementsByTagName("parsererror").length).toBe(0)
  return parsed
}

function fixtureDocument(relativePath: string): Document {
  return parseXmlPartForTest(readFileSync(join(FIXTURES, relativePath)))
}

function pptxParts(): Map<string, Document> {
  const names = [
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
    "ppt/slides/slide3.xml",
    "ppt/slides/_rels/slide1.xml.rels",
    "ppt/slides/_rels/slide2.xml.rels",
    "ppt/slides/_rels/slide3.xml.rels",
    "ppt/notesSlides/notesSlide1.xml",
    "ppt/notesSlides/notesSlide2.xml",
  ]
  return new Map(names.map((name) => [name, fixtureDocument(join("py-pptx", name))]))
}

function docxParagraphsOf(relativePath: string): string[] {
  const result = docxTextModelOf(fixtureDocument(relativePath))
  if (!result.ok) throw new Error(`extraction failed: ${result.code}`)
  if (result.model.kind !== "docx") throw new Error("unexpected model kind")
  return result.model.paragraphs
}

describe("docx text extraction (AC1)", () => {
  test("python-docx product: heading, bold run join, list items, and table cell text all surface", () => {
    const paragraphs = docxParagraphsOf("py-docx/word/document.xml")
    const joined = paragraphs.join("\n")
    expect(paragraphs).toContain("Quarterly Report Heading")
    // run 拼接:普通 run + 加粗 run 必须连成同一段(错误实现按 run 断段在此红)
    expect(paragraphs).toContain("Intro paragraph with bold emphasis")
    expect(paragraphs).toContain("first bullet item")
    expect(paragraphs).toContain("second bullet item")
    // 真 w:tbl 的单元格文本按文档序并入
    for (const cell of ["Widget", "Qty", "Anvil", "42"]) expect(joined).toContain(cell)
  })

  test("Cocoa (textutil) product: zero pStyle / flattened table / literal bullets still extract by content", () => {
    const paragraphs = docxParagraphsOf("cocoa-docx/word/document.xml")
    const joined = paragraphs.join("\n")
    expect(joined).toContain("Cocoa Heading Line")
    expect(joined).toContain("Cocoa intro paragraph text with plain body words.")
    // Cocoa 列表 = 字面「•」+ tab + 文本,同一段落
    expect(paragraphs.some((p) => p.includes("•") && p.includes("cocoa bullet one"))).toBe(true)
    expect(joined).toContain("cocoa bullet two")
    // Cocoa 表格拍平成段落 —— 内容仍必须出现
    for (const cell of ["CocoaCell Widget", "CocoaCell Qty", "CocoaCell Anvil", "CocoaCell 42"]) {
      expect(joined).toContain(cell)
    }
  })

  test("missing w:body fails closed with a code", () => {
    const empty = new DOMParser().parseFromString(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      "application/xml",
    ) as unknown as Document
    expect(docxTextModelOf(empty)).toEqual({ ok: false, code: "DOCX_BODY_MISSING" })
  })
})

describe("pptx text extraction (AC3)", () => {
  function extractedModel(parts: Map<string, Document>): OfficeTextModel & { kind: "pptx" } {
    const result = pptxTextModelOf(parts)
    if (!result.ok) throw new Error(`extraction failed: ${result.code}`)
    if (result.model.kind !== "pptx") throw new Error("unexpected model kind")
    return result.model
  }

  test("positive control: every sldId in the real fixture resolves an r:id through the test parser", () => {
    // 正对照:临时解析辅助的属性换序若失手,这里先红,而不是页序断言语义变假。
    const presentation = fixtureDocument("py-pptx/ppt/presentation.xml")
    const slideIds = Array.from(presentation.getElementsByTagName("p:sldId"))
    expect(slideIds.length).toBe(3)
    for (const el of slideIds) expect(el.getAttribute("r:id")).toMatch(/^rId\d+$/)
  })

  test("slide order follows sldIdLst through rels — never filename order", () => {
    const model = extractedModel(pptxParts())
    expect(model.slides.length).toBe(3)
    const texts = model.slides.map((slide) => slide.paragraphs.join("\n"))
    // 权威序 = [Charlie, Alpha, Bravo](sldIdLst 重排后);文件名序 = [Alpha, Bravo, Charlie]。
    // 按文件名排序的错误实现在这里红;串成一坨无页界的错误实现在逐页 not-contain 上红。
    expect(texts[0]).toContain("Charlie Slide Three")
    expect(texts[0]).not.toContain("Alpha Slide One")
    expect(texts[1]).toContain("Alpha Slide One")
    expect(texts[1]).toContain("bullet one alpha")
    expect(texts[1]).not.toContain("Bravo Slide Two")
    expect(texts[2]).toContain("Bravo Slide Two")
    expect(texts[2]).not.toContain("Charlie Slide Three")
  })

  test("speaker notes come from the standalone notesSlides part, per slide", () => {
    const model = extractedModel(pptxParts())
    const notes = model.slides.map((slide) => slide.notes.join("\n"))
    expect(notes[0]).toContain("note for charlie") // 权威序第 1 页 = Charlie
    expect(notes[1]).toContain("note for alpha")
    expect(model.slides[2]!.notes.join("")).not.toContain("note for") // Bravo 无备注 part
  })

  test("a slide named by sldIdLst but absent from the parts map fails closed", () => {
    const parts = pptxParts()
    parts.delete("ppt/slides/slide2.xml")
    expect(pptxTextModelOf(parts)).toEqual({ ok: false, code: "PPTX_SLIDE_PART_MISSING" })
  })

  test("a notes part named by slide rels but absent fails closed", () => {
    const parts = pptxParts()
    parts.delete("ppt/notesSlides/notesSlide2.xml")
    expect(pptxTextModelOf(parts)).toEqual({ ok: false, code: "PPTX_NOTES_PART_MISSING" })
  })

  test("missing presentation rels fails closed", () => {
    const parts = pptxParts()
    parts.delete("ppt/_rels/presentation.xml.rels")
    expect(pptxTextModelOf(parts)).toEqual({ ok: false, code: "PPTX_RELS_MISSING" })
  })
})
