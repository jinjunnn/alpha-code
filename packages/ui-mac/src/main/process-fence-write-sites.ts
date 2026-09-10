// REQ-159 (`#1321`) · AC3 —— 可写集单一权威的**另一半**:alpha 自己在 sidecar 进程里的每一处写盘调用点,
// 都要登记它落在 process-fence-profile.ts 的哪一行(W1…W19)之下。新增一处写盘而不登记 ⇒ 闸红。
//
// 为什么要这道闸:围栏装上之后不能加宽(勘破 §6.5)。alpha 代码若开始往可写集之外写(新功能加了个缓存目录),
// 用户看到的不是编译错误,是运行时 EPERM —— 最难诊断的一档还是**静默**的那种(§8.2 W7:provider 装不上而
// health 仍 200)。登记簿把「你写到哪里去」变成评审时必须回答的问题,而不是上线后用户的问题。
//
// ── 判据键在**写原语**上,不在文件清单上(勘破 §7.3)────────────────────────────────────
// 扫描器解析 `node:fs` / `fs` / `node:fs/promises` / `fs/promises` 的 import 拿到**本地绑定名**
// (`import { writeFileSync as sneaky }`、`import * as fs`、`import fs from`、多行 import —— 用的是
// TypeScript 的 AST,不是正则;§7.3 记着正则扫描漏掉了 `ext-config.ts:27` 那个多行 import 后面的 19 处写盘),
// 再只用这些绑定名找调用点:改名再调抓得到,朴素 grep 抓不到;不是 fs 的同名方法(`store.set` / `ws.write`)
// 不算。签名 = `<文件> <API> <第一个实参的归一化文本>`,跨行号 / 跨格式化稳定。
//
// ── 扫描的集合 = 真正跑在 sidecar 进程里的 alpha 代码 ──────────────────────────────────
//   · packages/ext/src/**(非测试):整个 ext bundle 装进引擎;
//   · packages/ui-mac/src/main/sidecar.ts 经相对 import 的传递闭包(不含 index.ts —— 那是 main 进程,不被围栏)。
// 这两处的产物就是 §7.3 派生签名的那四个文件(plugin.js / sidecar.js / ext-bundle-lock / sidecar-stop)的源码。
// 上游引擎(`virtual:opencode-server`)不在集合里:它的写入面在 §3 表 / §6.3.1,由 W4–W7、W11–W15 罩。
//
// 登记簿:scripts/process-fence-write-sites.tsv。判据:process-fence-write-sites.test.ts(含四条控制臂)。
// 重生:`bun packages/ui-mac/scripts/process-fence-write-sites.ts --write`(新行 root 填 TODO,评审必须改成真根)。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { WRITABLE_ROOT_IDS } from "./process-fence-profile"

/** 会在盘上留下痕迹的 fs API(同步 / promises 两套)。读 API 刻意不在:这道闸问的是「写到哪」。 */
export const FS_WRITE_APIS = new Set([
  "writeFileSync", "writeFile", "appendFileSync", "appendFile",
  "mkdirSync", "mkdir", "mkdtempSync", "mkdtemp",
  "renameSync", "rename", "rmSync", "rm", "rmdirSync", "rmdir", "unlinkSync", "unlink",
  "copyFileSync", "copyFile", "cpSync", "cp",
  "chmodSync", "chmod", "chownSync", "chown", "symlinkSync", "symlink", "linkSync", "link",
  "truncateSync", "truncate", "utimesSync", "utimes", "createWriteStream",
  "openSync", "open", "writeSync", "write",
])

const FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"])

export type WriteSite = {
  /** 仓库相对路径 */
  file: string
  api: string
  /** 第一个实参的归一化文本(空白折叠;没有实参时为 "") */
  firstArg: string
  line: number
}

/** 登记簿一行:签名三列 + 人声明的根。 */
export type LedgerRow = { file: string; api: string; firstArg: string; root: string }

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/** 扫描一份源码,返回全部经 fs 绑定发出的写盘调用。 */
export function scanWriteSites(file: string, source: string): WriteSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // 绑定名 → { kind: "named", api } | { kind: "namespace" }
  const bindings = new Map<string, { kind: "named"; api: string } | { kind: "namespace" }>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!FS_MODULES.has(stmt.moduleSpecifier.text)) continue
    const clause = stmt.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name) bindings.set(clause.name.text, { kind: "namespace" }) // `import fs from "node:fs"`
    const named = clause.namedBindings
    if (!named) continue
    if (ts.isNamespaceImport(named)) bindings.set(named.name.text, { kind: "namespace" })
    else
      for (const el of named.elements) {
        if (el.isTypeOnly) continue
        const api = (el.propertyName ?? el.name).text
        if (api === "promises") bindings.set(el.name.text, { kind: "namespace" })
        else bindings.set(el.name.text, { kind: "named", api })
      }
  }
  if (bindings.size === 0) return []

  const sites: WriteSite[] = []
  const record = (api: string, call: ts.CallExpression) => {
    if (!FS_WRITE_APIS.has(api)) return
    const first = call.arguments[0]
    sites.push({
      file,
      api,
      firstArg: first ? normalize(first.getText(sf)) : "",
      line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
    })
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        const b = bindings.get(callee.text)
        if (b?.kind === "named") record(b.api, node)
      } else if (ts.isPropertyAccessExpression(callee)) {
        // fs.writeFileSync(...) / fs.promises.writeFile(...) / fsp.writeFile(...)
        let root: ts.Expression = callee.expression
        if (ts.isPropertyAccessExpression(root) && root.name.text === "promises") root = root.expression
        if (ts.isIdentifier(root) && bindings.get(root.text)?.kind === "namespace") record(callee.name.text, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

const isProductionSource = (p: string) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".cases.ts") && !p.endsWith(".d.ts")

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (isProductionSource(p)) out.push(p)
  }
}

/** 从一个入口出发,沿相对 import 收传递闭包(只认相对说明符;bare 说明符是 node / npm / 上游,不进集合)。 */
export function relativeImportClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(entry)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const specifiers: string[] = []
    const collect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) specifiers.push(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifiers.push(node.arguments[0].text)
      }
      ts.forEachChild(node, collect)
    }
    collect(sf)
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) continue
      const base = resolve(dirname(file), spec)
      const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
      const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile())
      if (hit && isProductionSource(hit)) queue.push(hit)
    }
  }
  return [...seen].sort()
}

/** sidecar 进程里的 alpha 源码集合(见文件头)。返回仓库相对路径。 */
export function sidecarSourceFiles(repoRoot: string): string[] {
  const ext: string[] = []
  walk(join(repoRoot, "packages", "ext", "src"), ext)
  const sidecar = relativeImportClosure(join(repoRoot, "packages", "ui-mac", "src", "main", "sidecar.ts"))
  return [...new Set([...ext, ...sidecar])].map((p) => relative(repoRoot, p)).sort()
}

export function scanRepository(repoRoot: string): WriteSite[] {
  return sidecarSourceFiles(repoRoot).flatMap((rel) => scanWriteSites(rel, readFileSync(join(repoRoot, rel), "utf8")))
}

export const signatureOf = (s: { file: string; api: string; firstArg: string }) => `${s.file}\t${s.api}\t${s.firstArg}`

/**
 * 根列的合法取值:
 *   · 一个或多个 W-id(`W2+W6+W1`):写落在可写集这些行之下;
 *   · `arg`:路径来自调用方(通用 helper),具体根登记在调用方那一行;
 *   · `main-only`:这处代码住在 sidecar 的 import 闭包里,但**只有 main 进程会执行到它**(今天唯一的例子是
 *     alpha-environment.ts 的 initAlphaEnvironment 拓扑创建;server.ts:380 明写 sidecar 从不 init 它)。
 *     这是一个可达性声明,评审对着调用点核;不许拿它给真会在 sidecar 里跑的写入点开豁免。
 */
export function isValidRoot(root: string): boolean {
  if (root === "arg" || root === "main-only") return true
  return root.split("+").every((part) => Object.hasOwn(WRITABLE_ROOT_IDS, part))
}

export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (!line || line.startsWith("#")) continue
    const cols = line.split("\t")
    if (cols.length !== 4) throw new Error(`process-fence-write-sites.tsv: expected 4 TAB-separated columns, got ${cols.length}: ${line}`)
    rows.push({ file: cols[0]!, api: cols[1]!, firstArg: cols[2]!, root: cols[3]! })
  }
  return rows
}

export type LedgerDiff = { unregistered: WriteSite[]; stale: LedgerRow[]; invalidRoot: LedgerRow[]; duplicates: string[] }

/** 扫描结果 vs 登记簿:多一条少一条都算差;根写歪也算差。 */
export function diffLedger(sites: WriteSite[], ledger: LedgerRow[]): LedgerDiff {
  const seen = new Map<string, number>()
  for (const row of ledger) seen.set(signatureOf(row), (seen.get(signatureOf(row)) ?? 0) + 1)
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([sig]) => sig)
  const found = new Map<string, number>()
  for (const s of sites) found.set(signatureOf(s), (found.get(signatureOf(s)) ?? 0) + 1)
  // 同一文件里同签名出现多次是常见的(同一个 helper 被调两次);登记簿按签名去重,判「集合」相等。
  const registered = new Set(seen.keys())
  const unregistered = sites.filter((s, i, all) => !registered.has(signatureOf(s)) && all.findIndex((x) => signatureOf(x) === signatureOf(s)) === i)
  const stale = ledger.filter((row, i, all) => !found.has(signatureOf(row)) && all.findIndex((x) => signatureOf(x) === signatureOf(row)) === i)
  const invalidRoot = ledger.filter((row) => !isValidRoot(row.root))
  return { unregistered, stale, invalidRoot, duplicates }
}

/** 把扫描结果写成登记簿文本;已登记的行保留人填的根,新行标 TODO。 */
export function renderLedger(sites: WriteSite[], previous: LedgerRow[]): string {
  const roots = new Map(previous.map((r) => [signatureOf(r), r.root] as const))
  const unique = new Map<string, WriteSite>()
  for (const s of sites) if (!unique.has(signatureOf(s))) unique.set(signatureOf(s), s)
  const header = [
    "# REQ-159 (`#1321`) · AC3 —— alpha 在 sidecar 进程里的写盘调用点登记簿。",
    "# 四列 TAB:<文件> <fs API> <第一个实参(归一化)> <根>。根 = process-fence-profile.ts 的 W-id(可 `+` 连多个)、",
    "# `arg`(路径来自调用方;具体根登记在调用方那一行)、或 `main-only`(在闭包里但只有 main 进程执行到,见 isValidRoot)。",
    "# 新行由 --write 生成时根填 TODO —— 评审必须改成真根;",
    "# 点不出根 = 新的写入根 = 要么给可写集加行(带实测),要么改代码。判据:process-fence-write-sites.test.ts。",
    "# 重生:bun packages/ui-mac/scripts/process-fence-write-sites.ts --write(只写签名,不改已填的根)。",
  ]
  const body = [...unique.values()]
    .sort((a, b) => signatureOf(a).localeCompare(signatureOf(b)))
    .map((s) => `${signatureOf(s)}\t${roots.get(signatureOf(s)) ?? "TODO"}`)
  return `${header.join("\n")}\n${body.join("\n")}\n`
}
