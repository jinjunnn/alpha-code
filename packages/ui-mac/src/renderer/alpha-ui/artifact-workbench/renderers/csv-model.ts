// CSV/TSV 安全模型 — REQ-095(#187)。纯逻辑、零依赖,bun:test 可全测。
// 原则:
//   · 引号感知解析(RFC 4180 风格:双引号包裹、"" 转义、引号内换行);
//   · 单元格永远是**字面文本**(公式 =CMD(...) / =HYPERLINK(...) 原样呈现,不求值、不链接 ——
//     REQ-095 AC#4;渲染端映射为文本节点,无 HTML/无执行面);
//   · 行数上限 + 诚实截断标记(超大文件在 main 侧已按 2 MiB 截断,truncatedInput 由调用方传入)。

export type CsvDelimiter = "," | "\t" | ";"

export type CsvModel = {
  /** 首行(按约定视作表头;无法区分时仍如实呈现)。 */
  header: string[]
  rows: string[][]
  /** 实际解析到的数据行数(不含表头;含被截断丢弃的不计)。 */
  rowCount: number
  truncatedRows: boolean
  delimiter: CsvDelimiter
  columnCount: number
}

export const CSV_MAX_ROWS = 500
export const CSV_MAX_COLUMNS = 200

/** 从首个逻辑行探测分隔符(计数最多者;并列取 , > \t > ;)。 */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"))
  let counts: Record<CsvDelimiter, number> = { ",": 0, "\t": 0, ";": 0 }
  let inQuotes = false
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && (ch === "," || ch === "\t" || ch === ";")) counts[ch as CsvDelimiter] += 1
  }
  const order: CsvDelimiter[] = [",", "\t", ";"]
  let best: CsvDelimiter = ","
  for (const d of order) if (counts[d] > counts[best]) best = d
  return best
}

export function parseCsvModel(
  text: string,
  opts?: { maxRows?: number; delimiter?: CsvDelimiter | "auto" },
): CsvModel {
  const maxRows = Math.max(1, opts?.maxRows ?? CSV_MAX_ROWS)
  const delimiter: CsvDelimiter =
    !opts?.delimiter || opts.delimiter === "auto" ? detectDelimiter(text) : opts.delimiter

  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let inQuotes = false
  let truncatedRows = false

  const pushField = () => {
    if (record.length < CSV_MAX_COLUMNS) record.push(field)
    field = ""
  }
  const pushRecord = (): boolean => {
    pushField()
    // 跳过完全空行(单空字段的行)
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record)
      if (records.length > maxRows) {
        truncatedRows = true
        records.pop()
        return false
      }
    }
    record = []
    return true
  }

  outer: for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
      continue
    }
    switch (ch) {
      case '"':
        // 仅字段起始的引号开启引用;字段中途的引号按字面收下(宽容脏数据)
        if (field.length === 0) inQuotes = true
        else field += ch
        break
      case delimiter:
        pushField()
        break
      case "\r":
        if (text[i + 1] === "\n") break // \r\n 由 \n 分支收口
        if (!pushRecord()) break outer
        break
      case "\n":
        if (!pushRecord()) break outer
        break
      default:
        field += ch
    }
  }
  if (!truncatedRows && (field.length > 0 || record.length > 0)) pushRecord()

  const header = records.length > 0 ? records[0] : []
  const rows = records.slice(1)
  const columnCount = records.reduce((m, r) => Math.max(m, r.length), 0)
  return { header, rows, rowCount: rows.length, truncatedRows, delimiter, columnCount }
}
