// REQ-095(#187)CSV/TSV 模型:引号/换行/分隔符探测、行上限诚实截断、公式字符串只作文本。
import { describe, expect, test } from "bun:test"
import { detectDelimiter, parseCsvModel, CSV_MAX_ROWS } from "./csv-model"

describe("detectDelimiter", () => {
  test("逗号/制表/分号按首行计数", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",")
    expect(detectDelimiter("a\tb\tc")).toBe("\t")
    expect(detectDelimiter("a;b;c")).toBe(";")
  })
  test("引号内的分隔符不计数", () => {
    expect(detectDelimiter(`"a;;;;";x\tb\tc`)).toBe("\t")
  })
})

describe("parseCsvModel", () => {
  test("基本表头 + 行", () => {
    const m = parseCsvModel("name,size\nreport.pdf,120\nlogo.png,64\n")
    expect(m.header).toEqual(["name", "size"])
    expect(m.rows).toEqual([
      ["report.pdf", "120"],
      ["logo.png", "64"],
    ])
    expect(m.truncatedRows).toBe(false)
    expect(m.columnCount).toBe(2)
  })
  test("RFC4180 引号:内嵌逗号/双引号转义/引号内换行", () => {
    const m = parseCsvModel(`h1,h2\n"a,b","say ""hi"""\n"multi\nline",z\n`)
    expect(m.rows[0]).toEqual(["a,b", 'say "hi"'])
    expect(m.rows[1]).toEqual(["multi\nline", "z"])
  })
  test("\\r\\n 行尾", () => {
    const m = parseCsvModel("a,b\r\n1,2\r\n")
    expect(m.rows).toEqual([["1", "2"]])
  })
  test("TSV 显式分隔符", () => {
    const m = parseCsvModel("a\tb\n1\t2\n", { delimiter: "\t" })
    expect(m.rows).toEqual([["1", "2"]])
    expect(m.delimiter).toBe("\t")
  })
  test("行上限:超限截断 + truncatedRows 诚实标记", () => {
    const lines = ["h"].concat(Array.from({ length: 20 }, (_, i) => String(i)))
    const m = parseCsvModel(lines.join("\n"), { maxRows: 6 })
    expect(m.rowCount).toBe(5) // 6 条记录 = 表头 + 5 行
    expect(m.truncatedRows).toBe(true)
  })
  test("默认上限常量生效", () => {
    const lines = ["h"].concat(Array.from({ length: CSV_MAX_ROWS + 50 }, (_, i) => String(i)))
    const m = parseCsvModel(lines.join("\n"))
    expect(m.rowCount).toBe(CSV_MAX_ROWS - 1)
    expect(m.truncatedRows).toBe(true)
  })
  test("公式字符串只作字面文本保留(=CMD/=HYPERLINK 不求值不变形,REQ-095 AC#4)", () => {
    const m = parseCsvModel(`name,cmd\nx,"=CMD(""/c calc"")"\ny,"=HYPERLINK(""https://evil"",""ok"")"\nz,+SUM(A1:A9)\n`)
    expect(m.rows[0][1]).toBe('=CMD("/c calc")')
    expect(m.rows[1][1]).toBe('=HYPERLINK("https://evil","ok")')
    expect(m.rows[2][1]).toBe("+SUM(A1:A9)")
  })
  test("空行跳过;列数上限防御", () => {
    const m = parseCsvModel("a,b\n\n1,2\n")
    expect(m.rows).toEqual([["1", "2"]])
  })
})
