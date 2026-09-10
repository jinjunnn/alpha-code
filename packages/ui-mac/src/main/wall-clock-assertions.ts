// `#1300` —— 墙钟上界断言的枚举器 + 登记簿判官。
//
// ── 这一类是什么 ────────────────────────────────────────────────────────────────────
// 测试里断言「一段真实耗时 < 某个上界」:`expect(Date.now() - startedAt).toBeLessThan(100)`。
// 它断的不是被测对象对不对,是**机器当时有多闲**。单跑恒真,满载(实测同机 31 个 `bun test`
// 并跑)时是掷骰子:2026-09-08 `artifact-quota.test.ts` 那条 100ms 的上界收到 156ms,拦下的
// 是一个纯文档 PR。被拦的人查不出原因,最省事的动作就是 `--no-verify` —— 门里还拦着别的真问题。
//
// ── 为什么是扫描器 + 登记簿,不是逐条打补丁 ───────────────────────────────────────────
// 散文枚举漏掉的永远是最近新增的那一条。这里把「仓里有哪些墙钟上界断言」派生自**可检索的单一
// 权威**(TypeScript AST,不是正则 grep),每一条都必须在 scripts/wall-clock-assertions.tsv 里
// 有处置;新增一条不登记 ⇒ 红并点名 file:line;登记簿里有、代码里没了 ⇒ 也红(登记簿不许长成尸体)。
//
// ── 三条互相独立的检索轴(命中 = 任一轴命中;每轴各有控制臂)──────────────────────────
//   clock      被上界约束的那一侧,数据流里含时钟读数:`Date.now()` / `performance.now()` /
//              `process.hrtime[.bigint]()` / `Bun.nanoseconds()` / 无参 `new Date()`。经同文件的
//              `const`/`let` 初始化与 `x = …` 赋值**传递**解析(`const elapsed = Date.now() - t0`
//              再 `expect(elapsed)` 抓得到)。
//   name       被约束一侧出现耗时命名:elapsed / duration / latency / took / waited / spent /
//              wallclock(含属性名:`result.durationMs`、`timedOut.durationMs` —— 生产量出来的耗时,
//              测试里看不见时钟调用,只看得见名字)。
//   bound-name 上界一侧出现 UPPER_SNAKE 的时间常量:含 `_MS` / MILLIS / TIMEOUT / DEADLINE / BUDGET / FLOOR
//              (`toBeLessThan(ENGINE_FETCH_TIMEOUT_MS / 5)`、`< ATTRIBUTED_FLOOR_MS`);被约束一侧本身就是
//              常量/字面量时不算(那是取值纪律或下界)。
//   识别的断言形状:`expect(S).toBeLessThan(B)` / `toBeLessThanOrEqual` / `.not.toBeGreaterThan…`
//   及方向反过来的 `expect(B).toBeGreaterThan(S)`;以及 `expect(...)` / `assert(...)` 实参里任何
//   位置的比较表达式(`expect({ withinBudget: elapsed < 2000 }).toEqual(…)`)。
//   **不算**的:下界(`toBeGreaterThanOrEqual(20)` 之于耗时 —— 满载只会让它更真)。
//
// ── 诚实边界 ────────────────────────────────────────────────────────────────────────
//   · 三轴都不沾的形状测不到(生产量出的耗时用了别的名字、上界是裸数字):登记簿仍是显式清单。
//   · 轮询助手里的 `if (Date.now() - start > timeoutMs) throw` 是**邻类**(等待条件的墙钟超时),
//     不在本枚举里 —— 它与套件级 `--timeout` 同性质,另立票再议。
//
// 登记簿:scripts/wall-clock-assertions.tsv。判据:wall-clock-assertions.test.ts(含控制臂 + 反向夹具)。
// 重生:`bun packages/ui-mac/scripts/wall-clock-assertions.ts --write`(新行处置填 TODO,评审必须改成真处置)。

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import ts from "typescript"

/** 时钟读数的 callee 文本(属性链归一化后逐字比对)。 */
export const CLOCK_CALLEES = new Set([
  "Date.now",
  "performance.now",
  "globalThis.performance.now",
  "window.performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "hrtime",
  "hrtime.bigint",
  "Bun.nanoseconds",
])
/** 被约束一侧的耗时命名(标识符或属性名,子串、不分大小写)。 */
export const DURATION_NAME = /(elapsed|duration|latency|took|waited|spent|wall_?clock)/i
/**
 * 上界一侧的时间**常量**命名:只认 UPPER_SNAKE 常量(`ENGINE_FETCH_TIMEOUT_MS`、`ATTRIBUTED_FLOOR_MS`)。
 * camelCase 的 `durationMs` / `spawnMs` 是**量出来的值**,归 name/clock 轴;把它们也算进来会把
 * `expect(x.durationMs).toBeGreaterThanOrEqual(0)` 这种下界误报成上界(2026-09-09 实测 4 处)。
 */
export const BOUND_NAME = /^[A-Z][A-Z0-9_]*$/
const BOUND_NAME_WORDS = /(_MS|MILLIS|TIMEOUT|DEADLINE|BUDGET|FLOOR)/
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/

const LESS_MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual"])
const GREATER_MATCHERS = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"])
const ASSERT_CALLEES = new Set(["expect", "assert", "assert.ok", "assert.strictEqual", "assert.equal", "ok"])

/** 只解析含这些 token 的文件 —— 由三轴的常量派生,所以它是三轴的超集(不会把命中的文件筛掉)。 */
const PREFILTER = new RegExp(
  [
    "Date\\.now",
    "performance\\.now",
    "hrtime",
    "nanoseconds",
    "new Date\\(\\)",
    DURATION_NAME.source,
    BOUND_NAME_WORDS.source,
  ].join("|"),
  "i",
)

export type Axis = "clock" | "name" | "bound-name"

export type WallClockHit = {
  /** 仓库相对路径 */
  file: string
  /** 最近一层 test()/it() 的标题;不在 test 里为 "-" */
  test: string
  /** 整条断言语句的归一化文本(空白折叠) */
  assertion: string
  axes: Axis[]
  line: number
}

export type LedgerRow = { file: string; test: string; assertion: string; disposition: string; reason: string }

export const DISPOSITIONS = ["keep", "load-sensitive", "upstream", "not-elapsed"] as const

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

function calleeText(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeText(expr.expression)
    return left === undefined ? undefined : `${left}.${expr.name.text}`
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return calleeText(expr.expression)
  return undefined
}

function isClockRead(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = calleeText(node.expression)
    return callee !== undefined && CLOCK_CALLEES.has(callee)
  }
  // 无参 `new Date()` 是「现在」;带参的是一个固定时刻(`new Date(RACE_STARTED_AT)`),不算。
  if (ts.isNewExpression(node)) {
    const callee = calleeText(node.expression)
    return callee === "Date" && (node.arguments?.length ?? 0) === 0
  }
  return false
}

function namesIn(node: ts.Node): string[] {
  const names: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) names.push(n.text)
    else if (ts.isPropertyAccessExpression(n)) names.push(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return names
}

/** 从一个使用点向外找同名声明的初始化式 / 赋值右侧(词法作用域近似:逐层祖先块内查找)。 */
function definitionsOf(id: ts.Identifier): ts.Expression[] {
  const found: ts.Expression[] = []
  const name = id.text
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      // 形参:来源在调用方,这里看不见 —— 停止(name 轴仍可能命中)。
      if (scope.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return found
    }
    if (!(ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope))) continue
    for (const stmt of scope.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) found.push(decl.initializer)
        }
      }
      // `x = expr` 赋值(含嵌套语句里的):同一作用域内全部收下 —— 过报方向安全。
      const collectAssignments = (n: ts.Node) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name)
          found.push(n.right)
        if (!ts.isFunctionLike(n) || n === stmt) ts.forEachChild(n, collectAssignments)
      }
      collectAssignments(stmt)
    }
    if (found.length) return found
  }
  return found
}

/** 表达式的数据流里有没有时钟读数(经声明/赋值传递,带环保护)。 */
function derivesFromClock(expr: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (seen.has(expr)) return false
  seen.add(expr)
  let hit = false
  const visit = (n: ts.Node) => {
    if (hit) return
    if (isClockRead(n)) {
      hit = true
      return
    }
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      for (const def of definitionsOf(n)) {
        if (derivesFromClock(def, seen)) {
          hit = true
          return
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(expr)
  return hit
}

/** 只由 UPPER_SNAKE 常量与字面量组成的表达式(属性名不算)—— 一个常量不可能是量出来的耗时。 */
function isConstantExpression(expr: ts.Expression): boolean {
  let constant = true
  const visit = (n: ts.Node) => {
    if (!constant) return
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !UPPER_SNAKE.test(n.text)) constant = false
    else if (ts.isCallExpression(n) || ts.isNewExpression(n)) constant = false
    ts.forEachChild(n, visit)
  }
  visit(expr)
  return constant
}

function boundIsTimeConstant(bound: ts.Expression): boolean {
  let hit = false
  const visit = (n: ts.Node) => {
    if (hit) return
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && BOUND_NAME.test(n.text) && BOUND_NAME_WORDS.test(n.text)) hit = true
    ts.forEachChild(n, visit)
  }
  visit(bound)
  return hit
}

function axesOf(bounded: ts.Expression, bound: ts.Expression): Axis[] {
  const axes: Axis[] = []
  if (derivesFromClock(bounded)) axes.push("clock")
  if (namesIn(bounded).some((n) => DURATION_NAME.test(n))) axes.push("name")
  // 被约束的一侧若本身就是常量/字面量(`expect(PROBE_TIMEOUT_MS).toBeLessThan(FETCH_TIMEOUT_MS)`、
  // `toBeGreaterThanOrEqual(FLOOR_MS)` 里的 FLOOR_MS),那是取值纪律或下界,不是墙钟上界。
  if (!isConstantExpression(bounded) && boundIsTimeConstant(bound)) axes.push("bound-name")
  return axes
}

function enclosingTestTitle(node: ts.Node, sf: ts.SourceFile): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!ts.isCallExpression(cur)) continue
    const callee = calleeText(cur.expression)
    if (!callee) continue
    const head = callee.split(".")[0]
    if (head !== "test" && head !== "it") continue
    const first = cur.arguments[0]
    if (!first) return "?"
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return normalize(first.text)
    return normalize(first.getText(sf))
  }
  return "-"
}

function enclosingStatement(node: ts.Node): ts.Node {
  let cur: ts.Node = node
  while (cur.parent && !ts.isSourceFile(cur.parent) && !ts.isBlock(cur.parent) && !ts.isCaseClause(cur.parent)) cur = cur.parent
  return cur
}

/** 沿 expect(...).not.resolves.toBeX(...) 的链找到根 expect 调用与 .not。 */
function expectRoot(matcherCall: ts.CallExpression): { subject: ts.Expression; negated: boolean } | undefined {
  let negated = false
  let cur: ts.Expression = (matcherCall.expression as ts.PropertyAccessExpression).expression
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      if (cur.name.text === "not") negated = !negated
      cur = cur.expression
      continue
    }
    if (ts.isCallExpression(cur)) {
      if (ts.isIdentifier(cur.expression) && cur.expression.text === "expect" && cur.arguments[0]) {
        return { subject: cur.arguments[0], negated }
      }
      // expect.soft(...) / expectTypeOf 之类:不认
      return undefined
    }
    return undefined
  }
}

/** 扫描一份源码,返回全部墙钟上界断言。 */
export function scanSource(file: string, source: string): WallClockHit[] {
  if (!PREFILTER.test(source)) return []
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const hits = new Map<string, WallClockHit>()
  const record = (site: ts.Node, bounded: ts.Expression, bound: ts.Expression) => {
    const axes = axesOf(bounded, bound)
    if (axes.length === 0) return
    const stmt = enclosingStatement(site)
    const hit: WallClockHit = {
      file,
      test: enclosingTestTitle(site, sf),
      assertion: normalize(stmt.getText(sf)),
      axes,
      line: sf.getLineAndCharacterOfPosition(site.getStart(sf)).line + 1,
    }
    hits.set(`${hit.line}:${hit.assertion}`, hit)
  }
  const comparisonsIn = (node: ts.Node, site: ts.Node) => {
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind
        if (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) record(site, n.left, n.right)
        else if (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) record(site, n.right, n.left)
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression)
      if (callee && ASSERT_CALLEES.has(callee)) {
        for (const arg of node.arguments) comparisonsIn(arg, node)
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const matcher = node.expression.name.text
        if ((LESS_MATCHERS.has(matcher) || GREATER_MATCHERS.has(matcher)) && node.arguments[0]) {
          const root = expectRoot(node)
          if (root) {
            const less = LESS_MATCHERS.has(matcher) !== root.negated
            if (less) record(node, root.subject, node.arguments[0])
            else record(node, node.arguments[0], root.subject)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...hits.values()].sort((a, b) => a.line - b.line)
}

const TEST_FILE = /\.(test|spec|cases)\.tsx?$/
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "out", ".ts-dist", "build", "coverage", ".turbo", ".bun", ".sst"])

/** 仓内全部测试文件(仓库相对路径)。有 git 时按 git 视角(含未跟踪、排除 ignored);无 git(夹具)时走目录。 */
export function listTestFiles(repoRoot: string): string[] {
  if (existsSync(join(repoRoot, ".git"))) {
    const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`git ls-files 失败:${result.stderr}`)
    return result.stdout
      .split("\0")
      .filter((p: string) => TEST_FILE.test(p) && existsSync(join(repoRoot, p)))
      .sort()
  }
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (TEST_FILE.test(entry)) out.push(relative(repoRoot, p))
    }
  }
  walk(resolve(repoRoot))
  return out.sort()
}

export function scanRepository(repoRoot: string): WallClockHit[] {
  return listTestFiles(repoRoot).flatMap((rel) => scanSource(rel, readFileSync(join(repoRoot, rel), "utf8")))
}

export const signatureOf = (h: { file: string; test: string; assertion: string }) => `${h.file}\t${h.test}\t${h.assertion}`

export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (!line || line.startsWith("#")) continue
    const cols = line.split("\t")
    if (cols.length !== 5) throw new Error(`wall-clock-assertions.tsv: expected 5 TAB-separated columns, got ${cols.length}: ${line}`)
    rows.push({ file: cols[0]!, test: cols[1]!, assertion: cols[2]!, disposition: cols[3]!, reason: cols[4]! })
  }
  return rows
}

// ── 处置合法性需要的两个仓库事实 ───────────────────────────────────────────────────────
// 与 scripts/north-star-guard.sh 同一套判据(整包 carve-out + ADR-043 的自报家门),这里只做
// 不需要 git 的那一半(不查 origin/dev):方向是过报 —— 上游镜像里没有、又没自报家门的文件,这里
// 判为「不是 alpha 自有」,于是它拿不到 keep / load-sensitive 之外的任何处置也不会被误放行。
export const ALPHA_OWNED_PACKAGES = ["ext", "ui-mac", "alpha-contracts-consumer"] as const
export const ALPHA_OWNED_MARKER = "north-star:alpha-owned"
/** 每个 PR 都会跑到的套件根(alpha-check 第 [5/14] 步的四条命令 + [6/14] 登记簿点名)。 */
export const PER_PR_GATE_PREFIXES = [
  "packages/alpha-contracts-consumer/",
  "packages/ext/",
  "packages/ui-mac/src/",
  "packages/ui-mac/test-component/",
] as const

export function isAlphaOwned(file: string, content: string): boolean {
  if (ALPHA_OWNED_PACKAGES.some((pkg) => file.startsWith(`packages/${pkg}/`))) return true
  if (basename(file).startsWith("alpha-")) return true
  return content.includes(ALPHA_OWNED_MARKER)
}

export function inPerPrGate(file: string, gateRegistered: ReadonlySet<string>): boolean {
  return PER_PR_GATE_PREFIXES.some((p) => file.startsWith(p)) || gateRegistered.has(file)
}

/** 读 scripts/gate-files.tsv 的 `<workdir>/<path>` 集合(登记簿点名的闸门文件也属于每 PR 套件)。 */
export function gateRegisteredFiles(gateFilesTsv: string): Set<string> {
  const out = new Set<string>()
  for (const raw of gateFilesTsv.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const [, workdir, path] = raw.split("\t")
    if (workdir && path) out.add(`${workdir}/${path}`)
  }
  return out
}

export type LedgerContext = {
  gateRegistered: ReadonlySet<string>
  /** 读一份仓内文件(判 marker 用);读不到返回 undefined。 */
  read: (file: string) => string | undefined
}

/**
 * 一行登记的处置合不合法。规则(默认拒):
 *   keep            真正在测性能/时序契约,reason 必须写清余量与它守住的失败签名(≥ 40 字符)。
 *   load-sensitive  负载敏感档,**只许**给不在每 PR 套件里的文件(test-live/ 之类,单独命令跑)。
 *   upstream        上游文件,本仓不改(north-star)。**只许**给不是 alpha 自有的文件。
 *   not-elapsed     扫描器过报:被约束的不是耗时。reason 写清它是什么(≥ 20 字符)。
 *   rewrite 不是合法的登记值:改写 = 那条断言不再存在 = 不该有这一行(留痕写在抬头注释里)。
 */
export function dispositionError(row: LedgerRow, ctx: LedgerContext): string | undefined {
  if (!(DISPOSITIONS as readonly string[]).includes(row.disposition)) return `处置「${row.disposition}」不合法(只认 ${DISPOSITIONS.join(" / ")};rewrite = 删掉断言并删掉这一行)`
  const reason = row.reason.trim()
  if (row.disposition === "keep" && reason.length < 40) return "keep 的理由必须 ≥ 40 字符:写清余量倍数与它守住的失败签名"
  if (row.disposition === "not-elapsed" && reason.length < 20) return "not-elapsed 的理由必须 ≥ 20 字符:写清被约束的是什么"
  if (reason.length === 0) return "理由不许空"
  if (row.disposition === "load-sensitive" && inPerPrGate(row.file, ctx.gateRegistered))
    return "load-sensitive 只许给每 PR 套件之外的文件(PER_PR_GATE_PREFIXES 之外且不在 gate-files.tsv 里);在套件里的要么改写要么搬出去"
  if (row.disposition === "upstream") {
    const content = ctx.read(row.file) ?? ""
    if (isAlphaOwned(row.file, content)) return "upstream 只许给不是 alpha 自有的文件(不在 ext/ui-mac/alpha-contracts-consumer,basename 不以 alpha- 开头,正文无 north-star:alpha-owned)"
  }
  return undefined
}

export type LedgerDiff = {
  unregistered: WallClockHit[]
  stale: LedgerRow[]
  invalid: Array<{ row: LedgerRow; error: string }>
  duplicates: string[]
}

export function diffLedger(hits: WallClockHit[], ledger: LedgerRow[], ctx: LedgerContext): LedgerDiff {
  const counts = new Map<string, number>()
  for (const row of ledger) counts.set(signatureOf(row), (counts.get(signatureOf(row)) ?? 0) + 1)
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([sig]) => sig)
  const registered = new Set(counts.keys())
  const found = new Set(hits.map(signatureOf))
  const unregistered = hits.filter((h, i, all) => !registered.has(signatureOf(h)) && all.findIndex((x) => signatureOf(x) === signatureOf(h)) === i)
  const stale = ledger.filter((row, i, all) => !found.has(signatureOf(row)) && all.findIndex((x) => signatureOf(x) === signatureOf(row)) === i)
  const invalid = ledger.flatMap((row) => {
    const error = dispositionError(row, ctx)
    return error ? [{ row, error }] : []
  })
  return { unregistered, stale, invalid, duplicates }
}

/** 把扫描结果写成登记簿正文;已登记的行保留处置与理由,新行标 TODO。抬头由调用方(CLI)保留。 */
export function renderLedgerRows(hits: WallClockHit[], previous: LedgerRow[]): string {
  const kept = new Map(previous.map((r) => [signatureOf(r), r] as const))
  const unique = new Map<string, WallClockHit>()
  for (const h of hits) if (!unique.has(signatureOf(h))) unique.set(signatureOf(h), h)
  return [...unique.values()]
    .sort((a, b) => signatureOf(a).localeCompare(signatureOf(b)))
    .map((h) => {
      const prev = kept.get(signatureOf(h))
      return `${signatureOf(h)}\t${prev?.disposition ?? "TODO"}\t${prev?.reason ?? `axes=${h.axes.join("+")}`}`
    })
    .join("\n")
}
