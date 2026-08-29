// REQ-123(#1176)—— xlsx 提取模型判据(AC2)。
// 夹具是两个真实生成器的原样 part 字节(fixtures/xlsx/):
//   · xlsxwriter 3.2.9:共享串(t="s")+ 无 t 数值 + 布尔 + 带缓存值的公式 + 相对 rels 目标;
//   · openpyxl 3.1.5:内联串(t="inlineStr")+ t="n" 数值 + 空 <v/> 公式 + 绝对 rels 目标 + 空表。
// 生成命令留档:xlsxwriter/openpyxl 写最小工作簿后 unzip 取 xl/ 下相关 part,未做任何手改。
//
// ⚠️ 临时辅助声明:本文件里的 parsePart(字节 → 文档)只为在 #1174 的共享解析闸落地前
// 驱动纯模型 —— 生产接线时由那个共享函数(解码 + DOCTYPE 文本闸)替换,本辅助不导出、不进生产。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  buildXlsxWorkbook,
  columnLabel,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_ROWS,
  type XlsxSheetEntry,
  type XlsxSheetGrid,
} from "./xlsx-model"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

// —— 临时辅助(见文件头声明)——
function parsePart(bytes: Uint8Array): Document {
  return new DOMParser().parseFromString(new TextDecoder().decode(bytes), "text/xml") as unknown as Document
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document
}

/** 读夹具目录:递归收集文件,键 = 相对 part 名(posix 分隔)。测试直接吃夹具字节。 */
function loadFixtureParts(generator: "xlsxwriter" | "openpyxl"): Map<string, Document> {
  const root = join(import.meta.dir, "fixtures/xlsx", generator)
  const parts = new Map<string, Document>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = prefix === "" ? entry : `${prefix}/${entry}`
      if (statSync(abs).isDirectory()) walk(abs, rel)
      else parts.set(rel, parsePart(readFileSync(abs)))
    }
  }
  walk(root, "")
  return parts
}

function okSheet(entry: XlsxSheetEntry | undefined): XlsxSheetGrid {
  if (!entry || entry.status !== "ok") throw new Error(`sheet not ok: ${JSON.stringify(entry)}`)
  return entry.grid
}

function cellAt(grid: XlsxSheetGrid, ref: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)!
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return grid.rows[Number(match[2]) - 1]?.[col - 1]
}

describe("REQ-123 AC2 xlsx model — xlsxwriter 夹具(共享串 + 数值 + 多 sheet + 缓存公式)", () => {
  const result = buildXlsxWorkbook(loadFixtureParts("xlsxwriter"))

  test("工作表清单按 workbook.xml 顺序完整列出(不是只有第一张)", () => {
    if (!result.ok) throw new Error(result.code)
    expect(result.workbook.sheets.map((s) => s.name)).toEqual(["Overview", "数据"])
    expect(result.workbook.sheets.every((s) => s.status === "ok")).toBe(true)
  })

  test("共享串解析成文本 —— 显示索引数字的实现在此变红", () => {
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[0])
    expect(cellAt(grid, "A1")).toEqual({ text: "Item", kind: "text" })
    expect(cellAt(grid, "C2")).toEqual({ text: "Alpha 部件", kind: "text" })
    // A1 的原始 <v> 是共享串索引 "0" —— 它绝不能作为内容出现。
    expect(cellAt(grid, "A1")!.text).not.toBe("0")
  })

  test("第二张表内容真实可得(含跨表复用的共享串索引 0)", () => {
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[1])
    expect(cellAt(grid, "A2")).toEqual({ text: "华东", kind: "text" })
    expect(cellAt(grid, "B2")).toEqual({ text: "1200", kind: "number" })
    expect(cellAt(grid, "A3")).toEqual({ text: "Item", kind: "text" })
  })

  test("无 t 属性的数值格与布尔格按字面呈现", () => {
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[0])
    expect(cellAt(grid, "B2")).toEqual({ text: "42", kind: "number" })
    expect(cellAt(grid, "B3")).toEqual({ text: "3.5", kind: "number" })
    expect(cellAt(grid, "C3")).toEqual({ text: "TRUE", kind: "boolean" })
  })

  test("公式格显示生产器写入的缓存值,<f> 原文保留 —— 不求值", () => {
    if (!result.ok) throw new Error(result.code)
    const cell = cellAt(okSheet(result.workbook.sheets[0]), "B4")!
    expect(cell.kind).toBe("formula")
    expect(cell.formula).toBe("SUM(B2:B3)")
    // 显示的是 <v> 里的缓存字面 "45.5",不是我们算出来的任何东西。
    expect(cell.text).toBe("45.5")
  })
})

describe("REQ-123 AC2 xlsx model — openpyxl 夹具(内联串 + 绝对 rels 目标 + 空 <v/> 公式 + 空表)", () => {
  const result = buildXlsxWorkbook(loadFixtureParts("openpyxl"))

  test("绝对形态的 rels 目标(/xl/worksheets/…)解析成功,三张表齐全", () => {
    if (!result.ok) throw new Error(result.code)
    expect(result.workbook.sheets.map((s) => s.name)).toEqual(["Overview", "数据", "Empty"])
    expect(result.workbook.sheets.every((s) => s.status === "ok")).toBe(true)
  })

  test("内联串与 t=\"n\" 数值按字面呈现", () => {
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[0])
    expect(cellAt(grid, "A2")).toEqual({ text: "Widget", kind: "text" })
    expect(cellAt(grid, "B2")).toEqual({ text: "42", kind: "number" })
    expect(cellAt(grid, "C3")).toEqual({ text: "TRUE", kind: "boolean" })
    expect(cellAt(okSheet(result.workbook.sheets[1]), "A2")).toEqual({ text: "华东", kind: "text" })
  })

  test("无缓存值的公式格显示公式文本(带 = 前缀),仍不求值", () => {
    if (!result.ok) throw new Error(result.code)
    const cell = cellAt(okSheet(result.workbook.sheets[0]), "B4")!
    expect(cell.kind).toBe("formula")
    expect(cell.formula).toBe("SUM(B2:B3)")
    expect(cell.text).toBe("=SUM(B2:B3)")
    // 求值实现的指纹:算出 45.5 —— 必须红。
    expect(cell.text).not.toBe("45.5")
  })

  test("空表如实给零行网格(不伪造、不报错)", () => {
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[2])
    expect(grid.rows).toEqual([])
    expect(grid.columnCount).toBe(0)
  })
})

describe("REQ-123 AC2 xlsx model — 清单顺序与 rels 间接寻址(手写对抗夹具)", () => {
  // workbook 顺序 = [Zeta→sheet2.xml, Alpha→sheet1.xml],且 rId 数字与文件名故意错位:
  // 按文件名排序、或假定 rIdN↔sheetN.xml 的实现在此变红。
  const parts = new Map<string, Document>([
    [
      "xl/workbook.xml",
      parseXml(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
          `<sheet name="Zeta" sheetId="7" r:id="rId9"/><sheet name="Alpha" sheetId="8" r:id="rId1"/>` +
          `</sheets></workbook>`,
      ),
    ],
    [
      "xl/_rels/workbook.xml.rels",
      parseXml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`,
      ),
    ],
    ["xl/worksheets/sheet1.xml", parseXml(worksheetWithA1inline("from-sheet1"))],
    ["xl/worksheets/sheet2.xml", parseXml(worksheetWithA1inline("from-sheet2"))],
  ])

  test("顺序权威是 workbook.xml,目标经 rels 间接解析", () => {
    const result = buildXlsxWorkbook(parts)
    if (!result.ok) throw new Error(result.code)
    expect(result.workbook.sheets.map((s) => s.name)).toEqual(["Zeta", "Alpha"])
    expect(okSheet(result.workbook.sheets[0]).rows[0]![0]!.text).toBe("from-sheet2")
    expect(okSheet(result.workbook.sheets[1]).rows[0]![0]!.text).toBe("from-sheet1")
  })
})

function worksheetWithA1inline(text: string): string {
  return (
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>` +
    `</sheetData></worksheet>`
  )
}

describe("REQ-123 xlsx model — rels 目标校验(基线③.4:逃逸/外部/带 scheme 一律拒)", () => {
  const relsXml = (target: string, mode = "") =>
    parseXml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"${mode}/>` +
        `</Relationships>`,
    )
  const workbookXml = parseXml(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )

  const hostile: Array<[string, string, string]> = [
    ["路径逃逸(..)", "../secret.xml", ""],
    ["穿越出 worksheets 前缀", "worksheets/../../outside.xml", ""],
    ["绝对目标落在前缀外", "/xl/../secret.xml", ""],
    ["http scheme", "http://evil.example/x.xml", ""],
    ["反斜杠", "worksheets\\sheet1.xml", ""],
    ["外部 TargetMode", "worksheets/sheet1.xml", ` TargetMode="External"`],
  ]
  for (const [label, target, mode] of hostile) {
    test(`${label} → 该表进清单但标记 unresolved-rel,不当作可取路径`, () => {
      const parts = new Map<string, Document>([
        ["xl/workbook.xml", workbookXml],
        ["xl/_rels/workbook.xml.rels", relsXml(target, mode)],
        ["xl/worksheets/sheet1.xml", parseXml(worksheetWithA1inline("safe"))],
      ])
      const result = buildXlsxWorkbook(parts)
      if (!result.ok) throw new Error(result.code)
      expect(result.workbook.sheets[0]).toEqual({ name: "S", status: "missing", reason: "unresolved-rel" })
    })
  }

  test("rels 指向的 part 不在输入里 → missing-part(清单仍完整)", () => {
    const parts = new Map<string, Document>([
      ["xl/workbook.xml", workbookXml],
      ["xl/_rels/workbook.xml.rels", relsXml("worksheets/sheetX.xml")],
    ])
    const result = buildXlsxWorkbook(parts)
    if (!result.ok) throw new Error(result.code)
    expect(result.workbook.sheets[0]).toEqual({ name: "S", status: "missing", reason: "missing-part" })
  })
})

describe("REQ-123 xlsx model — 降级态与帽", () => {
  test("共享串缺席时 t=\"s\" 格是 unresolved,不显示索引数字", () => {
    const parts = new Map<string, Document>([
      [
        "xl/workbook.xml",
        parseXml(
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
      ],
      [
        "xl/_rels/workbook.xml.rels",
        parseXml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      ],
      [
        "xl/worksheets/sheet1.xml",
        parseXml(
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row></sheetData></worksheet>`,
        ),
      ],
    ])
    const result = buildXlsxWorkbook(parts)
    if (!result.ok) throw new Error(result.code)
    const cell = okSheet(result.workbook.sheets[0]).rows[0]![0]!
    expect(cell.kind).toBe("unresolved")
    expect(cell.text).toBe("")
  })

  test("workbook part 缺席 → 诚实错误码", () => {
    expect(buildXlsxWorkbook(new Map())).toEqual({ ok: false, code: "WORKBOOK_PART_MISSING" })
  })

  test("零工作表 → NO_SHEETS", () => {
    const parts = new Map<string, Document>([
      [
        "xl/workbook.xml",
        parseXml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>`),
      ],
    ])
    expect(buildXlsxWorkbook(parts)).toEqual({ ok: false, code: "NO_SHEETS" })
  })

  test("超帽的行与列被截断并诚实标记(不冻结、不伪造)", () => {
    const bigRow = `<row r="${XLSX_MAX_ROWS + 1}"><c r="A${XLSX_MAX_ROWS + 1}" t="inlineStr"><is><t>over</t></is></c></row>`
    // GS1 = 第 201 列(0 起 200)——正好越过列帽。
    const wideCell = `<row r="1"><c r="A1" t="inlineStr"><is><t>keep</t></is></c><c r="GS1" t="inlineStr"><is><t>wide</t></is></c></row>`
    const parts = new Map<string, Document>([
      [
        "xl/workbook.xml",
        parseXml(
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
      ],
      [
        "xl/_rels/workbook.xml.rels",
        parseXml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      ],
      [
        "xl/worksheets/sheet1.xml",
        parseXml(
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${wideCell}${bigRow}</sheetData></worksheet>`,
        ),
      ],
    ])
    const result = buildXlsxWorkbook(parts)
    if (!result.ok) throw new Error(result.code)
    const grid = okSheet(result.workbook.sheets[0])
    expect(grid.truncatedRows).toBe(true)
    expect(grid.truncatedColumns).toBe(true)
    expect(grid.rows.length).toBeLessThanOrEqual(XLSX_MAX_ROWS)
    expect(grid.columnCount).toBeLessThanOrEqual(XLSX_MAX_COLUMNS)
    expect(grid.rows[0]![0]!.text).toBe("keep")
  })
})

describe("REQ-123 xlsx model — 列头字母", () => {
  test("columnLabel 覆盖单/双/三字母边界", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLabel)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"])
  })
})
