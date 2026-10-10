// `#1376` —— sync-upstream 的「预期冲突」过滤表 与 north-star 守卫的清单 之间的**关系闸**。
//
// 这道门守的是什么(大白话):每天的上游同步任务遇到合并冲突时,会先把「我们预料到的冲突」
// 过滤掉(`.github/workflows/sync-upstream.yml` 里那行 `unexpected=…grep -v…`),剩下的才算
// 意外、才让同步中止。而「哪些文件算我们的」另有一份清单住在 `scripts/north-star-guard.sh`。
// 两份各自手写,仓里没有任何东西断言它们的关系 —— 哪天对不上,同步任务与检查脚本就会对同一个
// 文件给出相反的结论,而排查的人会以为是自己改错了。
//
// ── 勘破(2026-10-10,`origin/alpha`)—— 两份清单今天的差集,以及差异是不是有意的 ──────
// 过滤表(3 条):`bun.lock`(整行)、`packages/app/`(前缀)、`packages/ui/`(前缀)。
// 守卫:辖区 `packages`;carve-out ① ALPHA_OWNED_PACKAGES = ext ui-mac alpha-contracts-consumer;
//       carve-out ② ROUNDTRIP_PACKAGES = app ui;收编白名单 UPSTREAM_EXCLUDES 48 条。
//   · `packages/app/` `packages/ui/` == ROUNDTRIP_PACKAGES —— **同一个事实的两份副本**。两边的
//     理由都是 ADR-034:这两棵树由 pin + SOT 补丁投影,冲突由 apply_alpha_frontend_delta 整体
//     重写解决,所以对 sync 是预期冲突、对守卫是让给 roundtrip 门的 carve-out。
//   · `bun.lock` 不在守卫辖区内(辖区只到 `packages/`),守卫根本不判它 —— 它是 ADR-004 后果①
//     登记的结构性例外,sync 用 `--theirs` + 重生 lockfile 处理。不矛盾。
//   · 48 条收编白名单**全部不在**过滤表里 —— **有意的**。收编文件是 alpha 改过的上游文件,
//     上游一改它们就是真冲突,需要人按 ADR 逐条合并;过滤掉它们等于让 sync 自动选一边、静默丢掉
//     一侧的改动。所以它们必须落在「意外」里让同步中止。
//   · ALPHA_OWNED_PACKAGES 不在过滤表里 —— 也对:上游没有这三个包,合并不可能在它们上冲突。
// ⇒ 结论:两份不该字面相同。正确关系是三条,本文件逐条断言:
//   ① 过滤表里 `packages/` 下的条目 == ROUNDTRIP_PACKAGES(集合相等,前缀形 `packages/<p>/`);
//   ② 过滤表里 `packages/` 外的条目必须落在守卫辖区外(守卫不判它 ⇒ 两边不会给出相反结论);
//   ③ 过滤表与收编白名单**不相交**:任何一条收编路径都不得被过滤表吞掉。
//
// 为什么选「加判据」而不是「让一份派生自另一份」:过滤表那行在 workflow 的冲突分支里,该分支
// 由 sync-upstream-merge-order.test.ts 以真 git 仓 + `bash -e` 跑本体判行为;让它在运行期去调
// 守卫脚本取清单,会给那条每天只在 GitHub 上、只在有冲突时才走到的路径多一个运行期依赖,而换来
// 的只是本文件这三条静态关系。
//
// 判据的取法:ROUNDTRIP_PACKAGES / UPSTREAM_PATHS 从**生产守卫的 `--print-jurisdiction`** 取
// (它就是为「别人不许再抄一份」而开的只读模式,`#1288`),收编白名单从守卫源码的那张数组解析
// (它没有打印模式;local-gate-parity.test.ts 用同一种解析)。每条正向断言都带变异臂:先证明
// 这个手段测得出已知的坏,再用它判今天的好。解析不到东西时抛「测量作废」,不空对空地绿。

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SYNC_WORKFLOW_REL = ".github/workflows/sync-upstream.yml"
const GUARD_REL = "scripts/north-star-guard.sh"
const SYNC_WORKFLOW = readFileSync(resolve(REPO_ROOT, SYNC_WORKFLOW_REL), "utf8")
const GUARD_SOURCE = readFileSync(resolve(REPO_ROOT, GUARD_REL), "utf8")

type FilterEntry = { path: string; exact: boolean }
type Jurisdiction = { upstreamPaths: string[]; roundtrip: string[] }

/** 过滤表那一行:`unexpected="$(echo "$conflicts" | grep -v '^X' | … || true)"`。必须恰好一行。 */
function parseFilter(workflow: string): FilterEntry[] {
  const lines = workflow.split("\n").filter((l) => /^\s*unexpected="\$\(/.test(l))
  if (lines.length !== 1) throw new Error(`测量作废:${SYNC_WORKFLOW_REL} 里 unexpected= 赋值有 ${lines.length} 行(应恰好 1 行)`)
  const entries = [...lines[0].matchAll(/grep -v '\^([^']+)'/g)].map((m) => {
    const raw = m[1]
    const exact = raw.endsWith("$")
    return { path: exact ? raw.slice(0, -1) : raw, exact }
  })
  if (entries.length === 0) throw new Error("测量作废:过滤表里一条 grep -v 都没解析到")
  return entries
}

function printJurisdiction(guardPath: string): Jurisdiction {
  const r = Bun.spawnSync(["bash", guardPath, "--print-jurisdiction"], { cwd: REPO_ROOT })
  if (r.exitCode !== 0) throw new Error(`测量作废:--print-jurisdiction 退出码 ${r.exitCode}:${r.stderr.toString()}`)
  const kv = new Map(
    r.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => l.split("\t") as [string, string]),
  )
  const split = (k: string) => {
    const v = kv.get(k)?.trim()
    if (!v) throw new Error(`测量作废:--print-jurisdiction 没给出 ${k}`)
    return v.split(/\s+/)
  }
  return { upstreamPaths: split("UPSTREAM_PATHS"), roundtrip: split("ROUNDTRIP_PACKAGES") }
}

function parseExcludes(guard: string): string[] {
  const block = /^UPSTREAM_EXCLUDES=\(\n([\s\S]*?)^\)/m.exec(guard)?.[1]
  if (!block) throw new Error("测量作废:守卫里没解析到 UPSTREAM_EXCLUDES 数组")
  const items = [...block.matchAll(/^\s*':\(exclude\)([^']+)'/gm)].map((m) => m[1])
  if (items.length < 20) throw new Error(`测量作废:收编白名单只解析到 ${items.length} 条`)
  return items
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)

/** 三条关系;返回违例清单(空 = 绿)。 */
function relationViolations(filter: FilterEntry[], j: Jurisdiction, excludes: string[]): string[] {
  const out: string[] = []
  const inJurisdiction = (p: string) => j.upstreamPaths.some((u) => under(p, u))
  // ①
  const filterPkgs = filter
    .filter((e) => inJurisdiction(e.path))
    .map((e) => {
      const m = /^packages\/([^/]+)\/$/.exec(e.path)
      if (!m || e.exact) out.push(`① 过滤表里 packages/ 下的条目必须是整包前缀 packages/<p>/:${e.path}`)
      return m?.[1] ?? e.path
    })
  const a = [...new Set(filterPkgs)].sort().join(" ")
  const b = [...new Set(j.roundtrip)].sort().join(" ")
  if (a !== b) out.push(`① 过滤表的 packages/ 条目 [${a}] ≠ 守卫 ROUNDTRIP_PACKAGES [${b}]`)
  // ② packages/ 外的条目:守卫不判它们,天然满足(此处仅防 UPSTREAM_PATHS 将来扩出 packages/)
  for (const e of filter) {
    if (inJurisdiction(e.path) && !j.roundtrip.some((p) => e.path === `packages/${p}/`))
      out.push(`② 过滤表条目落在守卫辖区内却不是 roundtrip 包:${e.path}`)
  }
  // ③
  for (const x of excludes) {
    for (const e of filter) {
      const hit = e.exact ? under(e.path, x) || e.path === x : under(x, e.path.replace(/\/$/, "")) || under(e.path, x)
      if (hit) out.push(`③ 收编路径 ${x} 被过滤表条目 ${e.path} 吞掉 —— 它的冲突会被当成预期冲突静默解决`)
    }
  }
  return out
}

function mutateFilter(workflow: string, edit: (line: string) => string): string {
  const next = workflow.replace(/^(\s*unexpected="\$\(.*)$/m, (l) => edit(l))
  if (next === workflow) throw new Error("测量作废:变异没改到过滤表那一行")
  return next
}

function guardCopy(edit: (src: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "ns-guard-"))
  const path = join(dir, "north-star-guard.sh")
  copyFileSync(resolve(REPO_ROOT, GUARD_REL), path)
  const next = edit(GUARD_SOURCE)
  if (next === GUARD_SOURCE) throw new Error("测量作废:变异没改到守卫源码")
  writeFileSync(path, next)
  return path
}

const PROD_GUARD = resolve(REPO_ROOT, GUARD_REL)

describe("#1376 sync-upstream 过滤表 与 north-star 守卫清单 的关系", () => {
  test("解析自检:三份输入都解析得到,且过滤表今天就是勘破记下的那三条", () => {
    expect(parseFilter(SYNC_WORKFLOW)).toEqual([
      { path: "bun.lock", exact: true },
      { path: "packages/app/", exact: false },
      { path: "packages/ui/", exact: false },
    ])
    expect(printJurisdiction(PROD_GUARD)).toEqual({ upstreamPaths: ["packages"], roundtrip: ["app", "ui"] })
    expect(parseExcludes(GUARD_SOURCE).length).toBeGreaterThanOrEqual(20)
  })

  test("今天的生产文件满足三条关系", () => {
    expect(relationViolations(parseFilter(SYNC_WORKFLOW), printJurisdiction(PROD_GUARD), parseExcludes(GUARD_SOURCE))).toEqual([])
  })

  test("变异臂 ①:过滤表多一个 roundtrip 外的包(守卫没加)⇒ 红", () => {
    const wf = mutateFilter(SYNC_WORKFLOW, (l) => l.replace("| grep -v '^packages/ui/'", "| grep -v '^packages/ui/' | grep -v '^packages/session-ui/'"))
    const v = relationViolations(parseFilter(wf), printJurisdiction(PROD_GUARD), parseExcludes(GUARD_SOURCE))
    expect(v.join("\n")).toContain("packages/session-ui/")
  })

  test("变异臂 ①:守卫 ROUNDTRIP_PACKAGES 多一个包(过滤表没加)⇒ 红,且读的是守卫本体的打印", () => {
    const copy = guardCopy((s) => s.replace('ROUNDTRIP_PACKAGES="app ui"', 'ROUNDTRIP_PACKAGES="app ui session-ui"'))
    const v = relationViolations(parseFilter(SYNC_WORKFLOW), printJurisdiction(copy), parseExcludes(GUARD_SOURCE))
    expect(v.join("\n")).toContain("ROUNDTRIP_PACKAGES [app session-ui ui]")
  })

  test("变异臂 ①:过滤表少了 packages/ui/ ⇒ 红", () => {
    const wf = mutateFilter(SYNC_WORKFLOW, (l) => l.replace(" | grep -v '^packages/ui/'", ""))
    expect(relationViolations(parseFilter(wf), printJurisdiction(PROD_GUARD), parseExcludes(GUARD_SOURCE)).length).toBeGreaterThan(0)
  })

  test("变异臂 ③:过滤表吞掉一条收编文件 ⇒ 红且点名", () => {
    const wf = mutateFilter(SYNC_WORKFLOW, (l) => l.replace("grep -v '^bun.lock$'", () => "grep -v '^bun.lock$' | grep -v '^packages/core/src/permission.ts$'"))
    const v = relationViolations(parseFilter(wf), printJurisdiction(PROD_GUARD), parseExcludes(GUARD_SOURCE))
    expect(v.join("\n")).toContain("③ 收编路径 packages/core/src/permission.ts")
  })

  test("变异臂 ③:守卫在 roundtrip 包里新增一条收编(过滤表会吞掉它)⇒ 红", () => {
    const excludes = parseExcludes(guardCopyText((s) => s.replace("UPSTREAM_EXCLUDES=(\n", "UPSTREAM_EXCLUDES=(\n  ':(exclude)packages/app/src/app.tsx'\n")))
    const v = relationViolations(parseFilter(SYNC_WORKFLOW), printJurisdiction(PROD_GUARD), excludes)
    expect(v.join("\n")).toContain("packages/app/src/app.tsx")
  })
})

function guardCopyText(edit: (src: string) => string): string {
  const next = edit(GUARD_SOURCE)
  if (next === GUARD_SOURCE) throw new Error("测量作废:变异没改到守卫源码")
  return next
}
