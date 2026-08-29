// REQ-123(#1175)— docx / pptx 文本提取:对已解析 OOXML part 的纯模型构建。
//
// 铁律(方案基线 docs/design/2026-08-29-req123-office-extraction/baseline.md ③):
//   · 字节 → Document 的唯一通路是 #1174 的 `parseOoxmlContentPart`(ooxml-content.ts);
//     本模块不解压、不自建任何 XML 解析入口(src/ooxml-chokepoint.test.ts 是文本闸),
//     签名只接受字节 / 已解析 part,不接受路径 / URL / 回调 —— 出网面结构性关死;
//   · 输出是纯数据文本模型,呈现层只经 Solid 文本节点渲染(基线 ③ 类 3/5);
//   · pptx 页序唯一权威 = presentation.xml 的 sldIdLst 经 rels 解;禁止按文件名排序
//     (勘破实测 rId 与 slide 文件号不对应,真实重排后 sldIdLst ≠ 文件名序);
//   · 遍历只用 childNodes + localName/namespaceURI 扫描 —— 生产 Chromium 与测试 DOM 的
//     共同最小面(happy-dom 20.9 实测:NS 变体的元素/属性查询均不可用);
//   · 结构缺失一律 fail-closed 返回带 code 的失败,不伪造部分内容(基线 ③ 类 6)。

import { parseOoxmlContentPart, type OoxmlContentErrorCode } from "./ooxml-content"
import type { OoxmlDetection } from "./ooxml"

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
const REL_TYPE_NOTES_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"

export const PPTX_PRESENTATION_PART = "ppt/presentation.xml"
const PPTX_PRESENTATION_RELS_PART = "ppt/_rels/presentation.xml.rels"
const DOCX_DOCUMENT_PART = "word/document.xml"

export type OfficeTextModel =
  | { kind: "docx"; paragraphs: string[] }
  | { kind: "pptx"; slides: { paragraphs: string[]; notes: string[] }[] }

export type OfficeTextErrorCode =
  | "DOCX_DOCUMENT_MISSING"
  | "DOCX_BODY_MISSING"
  | "PPTX_PRESENTATION_MISSING"
  | "PPTX_SLIDE_LIST_MISSING"
  | "PPTX_RELS_MISSING"
  | "PPTX_SLIDE_REF_MISSING"
  | "PPTX_SLIDE_PART_MISSING"
  | "PPTX_NOTES_PART_MISSING"

/** 解析层的失败原因类别(#1174 的四个 code)原样上浮,不另造一套错误分类。 */
export type OfficeTextFailureCode = OfficeTextErrorCode | OoxmlContentErrorCode

export type OfficeTextResult =
  | { ok: true; model: OfficeTextModel }
  | { ok: false; code: OfficeTextFailureCode }

/** 呈现层消费的提取结果;undefined = 该 subtype 不在本提取器覆盖内或字节未随检测返回。 */
export type OfficeTextExtraction =
  | { status: "extracted"; model: OfficeTextModel }
  | { status: "failed"; code: OfficeTextFailureCode }

function fail(code: OfficeTextFailureCode): OfficeTextResult {
  return { ok: false, code }
}

// ---------------------------------------------------------------------------
// 字节侧提取器(基线 ③ 签名不变量:只接受字节)与呈现装配
// ---------------------------------------------------------------------------

/** `detectOoxmlContainer(bytes, { retainContentParts: true })` 的 retained 字节 → docx 文本模型。 */
export function extractDocxText(parts: ReadonlyMap<string, Uint8Array>): OfficeTextResult {
  const bytes = parts.get(DOCX_DOCUMENT_PART)
  if (!bytes) return fail("DOCX_DOCUMENT_MISSING")
  const parsed = parseOoxmlContentPart(bytes)
  if (!parsed.ok) return fail(parsed.code)
  return docxTextModelOf(parsed.document)
}

/** retained 字节 → pptx 文本模型;任一 ppt part 未过解析闸即整体 fail-closed。 */
export function extractPptxText(parts: ReadonlyMap<string, Uint8Array>): OfficeTextResult {
  const documents = new Map<string, Document>()
  for (const [name, bytes] of parts) {
    if (!name.startsWith("ppt/")) continue
    const parsed = parseOoxmlContentPart(bytes)
    if (!parsed.ok) return fail(parsed.code)
    documents.set(name, parsed.document)
  }
  return pptxTextModelOf(documents)
}

/**
 * 检测结果 → pass 分支的内容视图输入。字节只在 `status:"detected"` 且调用方 opt-in 了
 * `retainContentParts` 时存在(AC7 的结构保证);xlsx 归 #1176,此处刻意不越界。
 */
export function officeTextExtractionOf(detection: OoxmlDetection | undefined): OfficeTextExtraction | undefined {
  if (!detection || detection.status !== "detected" || !detection.parts) return undefined
  if (detection.subtype === "docx") return extractionOf(extractDocxText(detection.parts))
  if (detection.subtype === "pptx") return extractionOf(extractPptxText(detection.parts))
  return undefined
}

function extractionOf(result: OfficeTextResult): OfficeTextExtraction {
  return result.ok ? { status: "extracted", model: result.model } : { status: "failed", code: result.code }
}

// ---------------------------------------------------------------------------
// DOM 遍历最小面(childNodes + localName/namespaceURI;见文件头铁律)
// ---------------------------------------------------------------------------

function childElements(node: Element | Document): Element[] {
  const out: Element[] = []
  const children = node.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (child.nodeType === 1) out.push(child as Element)
  }
  return out
}

function findChild(node: Element, ns: string, local: string): Element | null {
  for (const child of childElements(node)) {
    if (child.localName === local && child.namespaceURI === ns) return child
  }
  return null
}

/** 文档序收集全部符合 ns+local 的后代元素(该元素类型不可自嵌套时安全)。 */
function collectDescendants(root: Element, ns: string, local: string): Element[] {
  const out: Element[] = []
  const walk = (el: Element) => {
    for (const child of childElements(el)) {
      if (child.localName === local && child.namespaceURI === ns) out.push(child)
      else walk(child)
    }
  }
  walk(root)
  return out
}

function textOf(el: Element): string {
  return el.textContent ?? ""
}

function attrByNs(el: Element, ns: string, local: string): string | null {
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!
    if (attr.localName === local && attr.namespaceURI === ns) return attr.value
  }
  return null
}

/**
 * 读 r:id。生产 Chromium 走命名空间匹配;限定名回退只为测试运行时
 * (happy-dom 对前缀属性不一定给 namespaceURI),对真实 Chromium 文档是死分支。
 */
function relationshipIdOf(el: Element): string | null {
  const byNs = attrByNs(el, NS_R, "id")
  if (byNs !== null) return byNs
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!
    if (attr.name === "r:id") return attr.value
  }
  return null
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

/**
 * `word/document.xml` 的 Document → 段落文本序列。
 * 最小路径 w:body//w:p//w:t(+ w:tab / w:br);表格单元格里的 w:p 按文档序自然并入 ——
 * 判据只能是内容串出现:Cocoa 产物零 w:pStyle、零 w:tbl(基线 ①,实测)。
 */
export function docxTextModelOf(document: Document): OfficeTextResult {
  const root = document.documentElement
  if (!root || root.localName !== "document" || root.namespaceURI !== NS_W) return fail("DOCX_DOCUMENT_MISSING")
  const body = findChild(root, NS_W, "body")
  if (!body) return fail("DOCX_BODY_MISSING")
  const paragraphs = collectDescendants(body, NS_W, "p").map(docxParagraphText)
  return { ok: true, model: { kind: "docx", paragraphs } }
}

function docxParagraphText(paragraph: Element): string {
  let out = ""
  const walk = (el: Element) => {
    for (const child of childElements(el)) {
      if (child.namespaceURI === NS_W && child.localName === "t") out += textOf(child)
      else if (child.namespaceURI === NS_W && child.localName === "tab") out += "\t"
      else if (child.namespaceURI === NS_W && child.localName === "br") out += "\n"
      else walk(child)
    }
  }
  walk(paragraph)
  return out
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

/**
 * pptx part 名(容器内路径)→ 已解析 Document 的映射 → 按权威页序的文本模型。
 * 页序:presentation.xml/sldIdLst 的 r:id 经 presentation.xml.rels 解;备注:每页
 * 自己的 rels 里 notesSlide 关系指向的独立 part。任何被点名却缺席的 part 都是失败,
 * 绝不静默给出错序或缺页的“部分内容”。
 */
export function pptxTextModelOf(parts: ReadonlyMap<string, Document>): OfficeTextResult {
  const presentation = parts.get(PPTX_PRESENTATION_PART)
  const root = presentation?.documentElement
  if (!root || root.localName !== "presentation" || root.namespaceURI !== NS_P) return fail("PPTX_PRESENTATION_MISSING")
  const slideIdList = findChild(root, NS_P, "sldIdLst")
  if (!slideIdList) return fail("PPTX_SLIDE_LIST_MISSING")
  const relationships = relationshipTargetsOf(parts.get(PPTX_PRESENTATION_RELS_PART), "ppt")
  if (!relationships) return fail("PPTX_RELS_MISSING")

  const slides: { paragraphs: string[]; notes: string[] }[] = []
  for (const slideId of childElements(slideIdList)) {
    if (slideId.localName !== "sldId" || slideId.namespaceURI !== NS_P) continue
    const relationshipId = relationshipIdOf(slideId)
    const slidePartName = relationshipId === null ? undefined : relationships.get(relationshipId)
    if (!slidePartName) return fail("PPTX_SLIDE_REF_MISSING")
    const slideDocument = parts.get(slidePartName)
    if (!slideDocument) return fail("PPTX_SLIDE_PART_MISSING")
    const notes = notesParagraphsOf(parts, slidePartName)
    if (!notes.ok) return notes.failure
    slides.push({ paragraphs: drawingParagraphsOf(slideDocument), notes: notes.paragraphs })
  }
  return { ok: true, model: { kind: "pptx", slides } }
}

/** slide part 的 a:p 段落文本(a:t + a:br;备注 part 同构)。 */
function drawingParagraphsOf(document: Document): string[] {
  const root = document.documentElement
  if (!root) return []
  return collectDescendants(root, NS_A, "p").map((paragraph) => {
    let out = ""
    const walk = (el: Element) => {
      for (const child of childElements(el)) {
        if (child.namespaceURI === NS_A && child.localName === "t") out += textOf(child)
        else if (child.namespaceURI === NS_A && child.localName === "br") out += "\n"
        else walk(child)
      }
    }
    walk(paragraph)
    return out
  })
}

type NotesLookup = { ok: true; paragraphs: string[] } | { ok: false; failure: OfficeTextResult }

function notesParagraphsOf(parts: ReadonlyMap<string, Document>, slidePartName: string): NotesLookup {
  const lastSlash = slidePartName.lastIndexOf("/")
  const directory = slidePartName.slice(0, lastSlash)
  const baseName = slidePartName.slice(lastSlash + 1)
  const relsDocument = parts.get(`${directory}/_rels/${baseName}.rels`)
  // 无 rels part = 该页没有任何关系(结构上允许)⇒ 无备注。
  if (!relsDocument) return { ok: true, paragraphs: [] }
  const relationships = relationshipEntriesOf(relsDocument, directory)
  if (!relationships) return { ok: false, failure: fail("PPTX_RELS_MISSING") }
  const notesTarget = relationships.find((rel) => rel.type === REL_TYPE_NOTES_SLIDE)?.target
  if (!notesTarget) return { ok: true, paragraphs: [] }
  const notesDocument = parts.get(notesTarget)
  // 被 rels 点名的备注 part 缺席:fail-closed,不静默丢备注(基线 ③ 类 6)。
  if (!notesDocument) return { ok: false, failure: fail("PPTX_NOTES_PART_MISSING") }
  return { ok: true, paragraphs: drawingParagraphsOf(notesDocument) }
}

type RelationshipEntry = { id: string; type: string; target: string }

function relationshipEntriesOf(document: Document, baseDirectory: string): RelationshipEntry[] | null {
  const root = document.documentElement
  if (!root || root.localName !== "Relationships" || root.namespaceURI !== NS_PKG_REL) return null
  const entries: RelationshipEntry[] = []
  for (const child of childElements(root)) {
    if (child.localName !== "Relationship" || child.namespaceURI !== NS_PKG_REL) continue
    // 外部目标不是 part,也绝不当作可取的东西(基线 ③ 类 3)。
    if (child.getAttribute("TargetMode") === "External") continue
    const id = child.getAttribute("Id")
    const type = child.getAttribute("Type")
    const rawTarget = child.getAttribute("Target")
    if (!id || !type || !rawTarget) continue
    const target = resolvePartName(baseDirectory, rawTarget)
    if (target === null) continue // 逃逸包根的目标不进映射;引用它的一格随后 fail-closed
    entries.push({ id, type, target })
  }
  return entries
}

function relationshipTargetsOf(document: Document | undefined, baseDirectory: string): Map<string, string> | null {
  if (!document) return null
  const entries = relationshipEntriesOf(document, baseDirectory)
  if (!entries) return null
  return new Map(entries.map((entry) => [entry.id, entry.target]))
}

/** 相对 part 目标 → 规范化容器内路径;`..` 逃逸包根返回 null。 */
function resolvePartName(baseDirectory: string, target: string): string | null {
  const stack = target.startsWith("/") ? [] : baseDirectory.split("/").filter(Boolean)
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack.length === 0 ? null : stack.join("/")
}
