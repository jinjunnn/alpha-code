// REQ-123(#1176)—— xlsx 工作表提取模型(AC2)。纯逻辑:输入是已解析的 part 文档,
// 输出是渲染端可直接呈现的工作表模型(工作表清单 + 每表的单元格网格)。
// 铁律(方案基线 docs/design/2026-08-29-req123-office-extraction/baseline.md):
//   · 本模块不解 zip、不自碰 DOM 解析 ——「字节 → 文档」只经 #1174 的共享解析闸
//     parseOoxmlContentPart(解码 + DOCTYPE/ENTITY/CDATA 文本闸 + 4 MiB 单 part 帽),
//     src/ooxml-chokepoint.test.ts 看住第二条路径;
//   · 公式永不求值:<f> 原文保留,显示缓存 <v>(生产器算好的)或公式文本本身;
//   · 工作表清单以 xl/workbook.xml 的 <sheets> 顺序为权威,目标经 workbook.xml.rels 解析 ——
//     不按文件名排序、不猜「rIdN ↔ sheetN.xml」(实测二者不对应);
//   · rels 目标校验在本层(基线③.4):拒外部目标 / 带 scheme / 逃逸路径,只接受 xl/worksheets/ 下的 part;
//   · 行列有帽 + 诚实截断标记(极端大工作表出范围,基线出范围段);
//   · 解析不出的格给明确的降级态(unresolved),不显示共享串索引数字、不伪造内容。

import { parseOoxmlContentPart } from "./ooxml-content"

export const XLSX_WORKBOOK_PART = "xl/workbook.xml"
export const XLSX_WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels"
export const XLSX_SHARED_STRINGS_PART = "xl/sharedStrings.xml"
export const XLSX_WORKSHEET_PREFIX = "xl/worksheets/"

export const XLSX_MAX_ROWS = 500
export const XLSX_MAX_COLUMNS = 200

export type XlsxCellKind = "text" | "number" | "boolean" | "formula" | "empty" | "unresolved"

export type XlsxCell = {
  /** 显示文本 —— 一律字面呈现(公式格 = 缓存值或 `=公式原文`),不求值、不链接。 */
  text: string
  kind: XlsxCellKind
  /** `<f>` 原文(不带 = 前缀);仅 kind === "formula" 时存在。 */
  formula?: string
}

export type XlsxSheetGrid = {
  /** 稠密网格:rows[r][c],空格补 kind:"empty"。 */
  rows: XlsxCell[][]
  columnCount: number
  truncatedRows: boolean
  truncatedColumns: boolean
}

export type XlsxSheetEntry =
  | { name: string; status: "ok"; grid: XlsxSheetGrid }
  /** 清单仍然如实列出,但该表读不出:rels 解析不到安全目标 / part 不在输入里 / 没过解析闸。 */
  | { name: string; status: "missing"; reason: "unresolved-rel" | "missing-part" | "part-unreadable" }

export type XlsxWorkbook = { sheets: XlsxSheetEntry[] }

export type XlsxWorkbookResult =
  | { ok: true; workbook: XlsxWorkbook }
  | { ok: false; code: "WORKBOOK_PART_MISSING" | "WORKBOOK_PART_UNREADABLE" | "NO_SHEETS"; detail?: string }

/** 0 → A,25 → Z,26 → AA … 列头字母。 */
export function columnLabel(index: number): string {
  let n = index
  let label = ""
  for (;;) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
    if (n < 0) return label
  }
}

/**
 * 从 part 字节构建工作表模型(基线③签名不变量:只接受字节,不接受路径 / URL / 回调)。
 * @param partBytes 规范 part 名(不带前导 `/`,与 detectOoxmlContainer 的 parts 键一致)→ 字节。
 *                  每个 part 都经 #1174 的共享解析闸;没过闸的 part 走诚实降级,不静默清洗。
 */
export function buildXlsxWorkbook(partBytes: ReadonlyMap<string, Uint8Array>): XlsxWorkbookResult {
  const workbookBytes = partBytes.get(XLSX_WORKBOOK_PART)
  if (!workbookBytes) return { ok: false, code: "WORKBOOK_PART_MISSING" }
  const workbookParse = parseOoxmlContentPart(workbookBytes)
  if (!workbookParse.ok) return { ok: false, code: "WORKBOOK_PART_UNREADABLE", detail: workbookParse.code }
  const workbookRoot = workbookParse.document.documentElement
  if (!workbookRoot || workbookRoot.localName !== "workbook")
    return { ok: false, code: "WORKBOOK_PART_UNREADABLE", detail: "not-a-workbook" }

  const sheetsEl = childrenByLocalName(workbookRoot, "sheets")[0]
  const sheetEls = sheetsEl ? childrenByLocalName(sheetsEl, "sheet") : []
  if (sheetEls.length === 0) return { ok: false, code: "NO_SHEETS" }

  const rels = parseWorksheetRels(parseOptionalPart(partBytes, XLSX_WORKBOOK_RELS_PART))
  const shared = parseSharedStrings(parseOptionalPart(partBytes, XLSX_SHARED_STRINGS_PART))

  const sheets = sheetEls.map((el, i): XlsxSheetEntry => {
    const name = el.getAttribute("name") || `Sheet${i + 1}`
    const rid = relationshipIdOf(el)
    const partName = rid ? rels.get(rid) : undefined
    if (!partName) return { name, status: "missing", reason: "unresolved-rel" }
    const bytes = partBytes.get(partName)
    if (!bytes) return { name, status: "missing", reason: "missing-part" }
    const parsed = parseOoxmlContentPart(bytes)
    if (!parsed.ok) return { name, status: "missing", reason: "part-unreadable" }
    const root = parsed.document.documentElement
    if (!root || root.localName !== "worksheet") return { name, status: "missing", reason: "part-unreadable" }
    return { name, status: "ok", grid: buildSheetGrid(root, shared) }
  })
  return { ok: true, workbook: { sheets } }
}

/** 可选 part(rels / sharedStrings):缺席或没过解析闸都退到 null,由各自的降级语义兜住。 */
function parseOptionalPart(partBytes: ReadonlyMap<string, Uint8Array>, name: string): Document | undefined {
  const bytes = partBytes.get(name)
  if (!bytes) return undefined
  const parsed = parseOoxmlContentPart(bytes)
  return parsed.ok ? parsed.document : undefined
}

// ── workbook.xml.rels:rId → 已校验的 worksheet part 名 ─────────────────────────

const WORKSHEET_REL_TYPE_SUFFIX = "/worksheet"

function parseWorksheetRels(doc: Document | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const root = doc?.documentElement
  if (!root || root.localName !== "Relationships") return out
  for (const rel of childrenByLocalName(root, "Relationship")) {
    const id = rel.getAttribute("Id")
    const type = rel.getAttribute("Type")
    if (!id || !type || !type.endsWith(WORKSHEET_REL_TYPE_SUFFIX)) continue
    // 外部目标绝不进清单:rels 目标不是可取字节的东西,更不是可请求的 URL。
    if ((rel.getAttribute("TargetMode") ?? "Internal") === "External") continue
    const target = resolveWorksheetTarget(rel.getAttribute("Target") ?? "")
    if (target) out.set(id, target)
  }
  return out
}

/**
 * 把 rels Target 解析成规范 part 名。实测两种真实形状都存在:
 * xlsxwriter 写相对目标(`worksheets/sheet1.xml`,相对 `xl/`),openpyxl 写绝对目标
 * (`/xl/worksheets/sheet1.xml`)。带 scheme / 反斜杠 / 控制字符 / 逃逸出根的一律拒。
 */
function resolveWorksheetTarget(target: string): string | null {
  if (!target) return null
  if (/[\\\u0000-\u001f\u007f?#%]/.test(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//"))
    return null
  const absolute = target.startsWith("/")
  const output: string[] = absolute ? [] : ["xl"]
  for (const segment of (absolute ? target.slice(1) : target).split("/")) {
    if (segment === "") return null
    if (segment === ".") continue
    if (segment === "..") {
      if (output.length === 0) return null
      output.pop()
      continue
    }
    output.push(segment)
  }
  const partName = output.join("/")
  // 只有 worksheet 前缀下的 part 是合法目标(也是解压咽喉白名单会保留字节的范围)。
  return partName.startsWith(XLSX_WORKSHEET_PREFIX) ? partName : null
}

/** `<sheet r:id="…">` 的关系 id;前缀不可假定恒为 `r`,按属性 localName 兜底。 */
function relationshipIdOf(el: Element): string | null {
  const direct = el.getAttribute("r:id")
  if (direct) return direct
  for (const attr of Array.from(el.attributes)) {
    const local = attr.name.includes(":") ? attr.name.slice(attr.name.lastIndexOf(":") + 1) : attr.name
    if (local === "id" && attr.name !== "id") return attr.value
  }
  return null
}

// ── sharedStrings.xml:按 <si> 顺序取富文本拼接 ────────────────────────────────

function parseSharedStrings(doc: Document | undefined): string[] {
  const root = doc?.documentElement
  if (!root || root.localName !== "sst") return []
  return childrenByLocalName(root, "si").map(collectText)
}

/** 拼接元素下所有 `<t>` 的文本(覆盖富文本 run `<r><t>`),跳过注音 `<rPh>` 子树。 */
function collectText(el: Element): string {
  let out = ""
  for (const child of Array.from(el.children)) {
    if (child.localName === "rPh") continue
    out += child.localName === "t" ? (child.textContent ?? "") : collectText(child)
  }
  return out
}

// ── 单表网格 ──────────────────────────────────────────────────────────────────

const EMPTY_CELL: XlsxCell = { text: "", kind: "empty" }

function buildSheetGrid(worksheetRoot: Element, shared: string[]): XlsxSheetGrid {
  const sheetData = childrenByLocalName(worksheetRoot, "sheetData")[0]
  const sparse = new Map<number, Map<number, XlsxCell>>()
  let maxRow = -1
  let maxCol = -1
  let truncatedRows = false
  let truncatedColumns = false
  let lastRow = -1

  for (const rowEl of sheetData ? childrenByLocalName(sheetData, "row") : []) {
    const rowRef = rowEl.getAttribute("r")
    const rowIndex = rowRef && /^\d+$/.test(rowRef) ? Number(rowRef) - 1 : lastRow + 1
    lastRow = rowIndex
    if (rowIndex < 0) continue
    if (rowIndex >= XLSX_MAX_ROWS) {
      truncatedRows = true
      continue
    }
    let lastCol = -1
    const cells = new Map<number, XlsxCell>()
    for (const cellEl of childrenByLocalName(rowEl, "c")) {
      const ref = cellEl.getAttribute("r")
      const parsed = ref ? parseColumnOf(ref) : null
      const col = parsed ?? lastCol + 1
      lastCol = col
      if (col >= XLSX_MAX_COLUMNS) {
        truncatedColumns = true
        continue
      }
      const cell = buildCell(cellEl, shared)
      if (cell.kind === "empty") continue
      cells.set(col, cell)
      if (col > maxCol) maxCol = col
    }
    if (cells.size === 0) continue
    sparse.set(rowIndex, cells)
    if (rowIndex > maxRow) maxRow = rowIndex
  }

  const columnCount = maxCol + 1
  const rows: XlsxCell[][] = []
  for (let r = 0; r <= maxRow; r++) {
    const rowCells = sparse.get(r)
    const row: XlsxCell[] = []
    for (let c = 0; c < columnCount; c++) row.push(rowCells?.get(c) ?? EMPTY_CELL)
    rows.push(row)
  }
  return { rows, columnCount, truncatedRows, truncatedColumns }
}

/** `"BC12"` → 列 index(0 起);解析不了返回 null(调用方顺延)。 */
function parseColumnOf(ref: string): number | null {
  const match = /^([A-Za-z]{1,3})\d{1,7}$/.exec(ref)
  if (!match) return null
  let col = 0
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return col - 1
}

/**
 * 单元格 → 显示模型。`c/@t` 是唯一类型权威(实测):
 * `s`=共享串索引 / `inlineStr`=内联 / `b`=布尔 / `str`|`e`=字面串 / 缺省或 `n`=数值。
 * 实测补充:xlsxwriter 的数值格根本不写 t;openpyxl 写 t="n"。二者都走缺省分支。
 * `<f>` 在场即公式格:显示缓存 `<v>`(openpyxl 会写空 `<v/>` ⇒ 显示公式文本),永不求值。
 */
function buildCell(cellEl: Element, shared: string[]): XlsxCell {
  const type = cellEl.getAttribute("t") ?? "n"
  const vEl = childrenByLocalName(cellEl, "v")[0]
  const fEl = childrenByLocalName(cellEl, "f")[0]
  const vText = vEl?.textContent ?? ""

  let base: XlsxCell
  if (type === "s") {
    const index = /^\d+$/.test(vText.trim()) ? Number(vText.trim()) : -1
    const resolved = index >= 0 && index < shared.length ? shared[index] : null
    // 查不到共享串 = 降级态,绝不把索引数字当内容显示。
    base = resolved === null ? { text: "", kind: "unresolved" } : { text: resolved, kind: "text" }
  } else if (type === "inlineStr") {
    const isEl = childrenByLocalName(cellEl, "is")[0]
    base = isEl ? { text: collectText(isEl), kind: "text" } : { text: "", kind: "empty" }
  } else if (type === "b") {
    base = vEl ? { text: vText.trim() === "1" ? "TRUE" : "FALSE", kind: "boolean" } : { text: "", kind: "empty" }
  } else if (type === "str" || type === "e") {
    base = vEl ? { text: vText, kind: "text" } : { text: "", kind: "empty" }
  } else {
    base = vEl && vText !== "" ? { text: vText, kind: "number" } : { text: "", kind: "empty" }
  }

  if (!fEl) return base
  const formula = fEl.textContent ?? ""
  const cached = base.kind === "empty" || base.kind === "unresolved" ? "" : base.text
  const text = cached !== "" ? cached : formula !== "" ? `=${formula}` : ""
  return { text, kind: "formula", formula }
}

// ── DOM 小工具(localName 匹配,前缀无关;两种运行时都实测过)────────────────────

function childrenByLocalName(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((child) => child.localName === name)
}
