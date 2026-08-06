import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const MATRIX_PATH = join(
  REPO_ROOT,
  "docs/verification/2026-07-31-req128-capability-matrix/matrix.tsv",
)
const MATRIX_BODY = readFileSync(MATRIX_PATH, "utf8")
const COLUMNS = [
  "phase1_item",
  "producer_fixture",
  "consumer_entrypoint",
  "expected_verdict",
  "reason_code",
  "evidence_gate_file",
  "evidence_test_name",
] as const
const PHASE1_ITEMS = [
  "producer-to-signed-catalog",
  "current-host-sibling-key-tolerance",
  "foundation-host-gate-order",
  "safe-view-and-reevaluation",
  "secret-prerequisite-lifecycle",
  "single-component-admission",
  "user-reachable-install-path",
] as const

type MatrixRow = Record<(typeof COLUMNS)[number], string>

const SELF_GATE_PATH = "packages/ui-mac/src/main/req128-capability-matrix.test.ts"

const rows = parseMatrix()

/**
 * 证据只能来自**本闸自己的 `delegates_to`**,不是全量 61 条登记簿。
 *
 * 用全表的话,一格 REQ-128 密钥生命周期的证据可以指向渲染层的 CSS 对比度测试而全绿
 * (审计实测)。`delegates_to` 是现成的权威:`gate-file-registry.test.ts` 已强制
 * 「受托方必须也在册」,所以这里收窄不会漏掉合法证据,而任何新引入的 evidence 文件
 * 必须**先进 delegates_to** —— 咽喉对新成员默认拒绝,枚举对新成员默认放行。
 */
const registeredGates = new Set(
  readFileSync(join(REPO_ROOT, "scripts/gate-files.tsv"), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .flatMap((line) => {
      const [, workdir, path, delegates] = line.split("\t")
      if (`${workdir}/${path}` !== SELF_GATE_PATH) return []
      return (delegates ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
    }),
)

describe("REQ-128 Phase 1 capability evidence matrix", () => {
  test("covers all seven Phase 1 items and pins the scoped boundaries", () => {
    const unknown = rows
      .map((row) => row.phase1_item)
      .filter((item) => !PHASE1_ITEMS.includes(item as (typeof PHASE1_ITEMS)[number]))
    expect(unknown, "matrix must not reserve Phase 2/3/4 rows").toEqual([])
    for (const item of PHASE1_ITEMS)
      expect(
        rows.filter((row) => row.phase1_item === item).length,
        `${item} has no evidence cell`,
      ).toBeGreaterThan(0)
    expect(rows.every((row) => COLUMNS.every((column) => row[column].length > 0))).toBe(true)
    // 逐格下界。只验「每项 ≥1 格」的话,47 格里 44 格可以静默删掉而本闸仍全绿
    // (审计跑了 47 次独立验证)。本票的产物**就是这份数据**,所以下界要落在数据上,
    // 而不是只落在测试条数上 —— 后者是 gate-files.tsv 的活,它抓不到数据被掏空。
    expect(rows.length, "matrix row floor — 删格必须变红,不留余量").toBe(46)
    expect(
      Object.fromEntries(
        PHASE1_ITEMS.map((item) => [item, rows.filter((row) => row.phase1_item === item).length]),
      ),
      "per-item floors — 某一面被掏空时要指得出是哪一面",
    ).toEqual({
      "producer-to-signed-catalog": 13,
      "current-host-sibling-key-tolerance": 1,
      "foundation-host-gate-order": 3,
      "safe-view-and-reevaluation": 9,
      "secret-prerequisite-lifecycle": 9,
      "single-component-admission": 7,
      "user-reachable-install-path": 4,
    })
    expect(MATRIX_BODY).toContain(
      "cut — 无真实用户,不做向后兼容(owner 直令 2026-07-31)",
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        phase1_item: "current-host-sibling-key-tolerance",
        reason_code: "cut-owner-directed-current-host-only",
      }),
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        phase1_item: "producer-to-signed-catalog",
        expected_verdict: "deferred",
        reason_code: "deferred-alpha-web-108",
      }),
    )
    // #737 已合并(1b808f23):宿主的契约文法替身已删除并收口到 shared/extension-name.ts,
    // 那条 known-defect 边界不再成立,连同它的钉子一起撤。
    // ⚠️ 保留这段注释是为了说明**为什么这里现在什么都不钉** —— 一条已解决的 known-defect
    // 若留在矩阵里,读的人会以为还有个洞;而留一格假指针指向无关的绿测试更坏(那正是 R1 的 M-2)。
    expect(MATRIX_BODY).not.toContain("known-defect")
    expect(MATRIX_BODY).not.toContain("alpha-code#738")
  })

  test("every evidence gate file is registered", () => {
    const unregistered = rows
      .map((row) => row.evidence_gate_file)
      .filter((path, index, paths) => !registeredGates.has(path) && paths.indexOf(path) === index)
    expect(unregistered, "matrix points at evidence outside scripts/gate-files.tsv").toEqual([])
  })

  test("every evidence test name is a declared test or test.each title", () => {
    const missing = rows.flatMap((row) => {
      if (!registeredGates.has(row.evidence_gate_file)) return []
      return declaredTestNames(
        readFileSync(join(REPO_ROOT, row.evidence_gate_file), "utf8"),
      ).has(row.evidence_test_name)
        ? []
        : [`${row.evidence_gate_file} :: ${row.evidence_test_name}`]
    })
    expect(
      missing,
      "an evidence name must be the first string argument of test(...) or the title call after test.each(...); ordinary source strings do not count",
    ).toEqual([])
  })
})

function parseMatrix(): MatrixRow[] {
  const lines = MATRIX_BODY.split("\n").filter(
    (line) => line.trim() && !line.trimStart().startsWith("#"),
  )
  const [header, ...body] = lines
  if (header !== COLUMNS.join("\t")) throw new Error("matrix.tsv column header drifted")
  return body.map((line, index) => {
    const fields = line.split("\t")
    if (fields.length !== COLUMNS.length)
      throw new Error(
        `matrix.tsv row ${index + 2} has ${fields.length} fields; expected ${COLUMNS.length}`,
      )
    return Object.fromEntries(
      COLUMNS.map((column, field) => [column, fields[field]!]),
    ) as MatrixRow
  })
}

function declaredTestNames(source: string) {
  const names = new Set<string>()
  for (const match of source.matchAll(/(^|[^.\w$])test\s*\(/g)) {
    const name = stringArgumentAt(source, match.index + match[0].lastIndexOf("(") + 1)
    if (name !== undefined) names.add(name)
  }
  for (const match of source.matchAll(/(^|[^.\w$])test\.each\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(")
    const closing = closingParenthesis(source, opening)
    if (closing === undefined) continue
    const titleCall = source.indexOf("(", closing + 1)
    if (titleCall === -1 || source.slice(closing + 1, titleCall).trim()) continue
    const name = stringArgumentAt(source, titleCall + 1)
    if (name !== undefined) names.add(name)
  }
  return names
}

function stringArgumentAt(source: string, start: number) {
  const opening = source.slice(start).search(/\S/)
  if (opening === -1) return
  const index = start + opening
  const quote = source[index]
  if (quote !== '"' && quote !== "'" && quote !== "`") return
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") {
      cursor++
      continue
    }
    if (source[cursor] === quote) return source.slice(index + 1, cursor)
  }
}

function closingParenthesis(source: string, opening: number) {
  let depth = 0
  let quote = ""
  let lineComment = false
  let blockComment = false
  for (let index = opening; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (char === quote) quote = ""
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(") depth++
    if (char !== ")") continue
    depth--
    if (depth === 0) return index
  }
}
