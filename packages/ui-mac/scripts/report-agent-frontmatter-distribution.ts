#!/usr/bin/env bun
/**
 * `#848`:plugin-level agent frontmatter 分布报告。
 *
 * 量什么:仓内语料夹具里 **plugin-level** `agents/**\/*.md` 的逐字字节(口径 = 规模普查
 * census G3:`<插件根>/agents/**`,插件根 = 带 `.claude-plugin/plugin.json` 的目录;
 * 技能内层 agents 不算,但逐个点名列出,不静默)。对每份:
 *   ① 整文件喂**生产** `agentMdToEntry` → 通过 / 拒因(= 独立复算 9/43 那个数);
 *   ② 每个顶层键用**生产解析器本身**做探针:合成最小文档(`description: probe` + 该键的
 *      原文行,含其缩进续行),看解析器接受(键进条目)/ 忽略(解析成功但键不进条目,
 *      如 `name`)/ 拒绝(带拒因)。**不自写第二份文法** —— 值形状只做观测性标注,
 *      处置一律以生产解析器为准(「手写别人文法的替身」是本仓记录在案最贵的返工形态)。
 *
 * 占位守卫(loud):任一 plugin-level agent 条目缺 text ⇒ 立刻失败退出,不出任何数。
 * 把 'aaaa…' 喂进解析器得到的不是下界,是**一个假的零**(census G6 的警告原文)。
 * 在 fixture 重生(#848 阶段 2)之前,本脚本对仓内夹具**必须**走到这条失败。
 *
 * 用法:bun packages/ui-mac/scripts/report-agent-frontmatter-distribution.ts [--selftest]
 *   --selftest:在内存合成语料上跑全管线并断言预期(确定性,零磁盘依赖)。
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { agentMdToEntry } from "../src/main/agent-md-entry"

type Entry = { path: string; mode: number } & ({ text: string } | { size: number })
type Fixture = { schema: string; roots: string[]; entries: Entry[] }

const FIXTURE_PATH = path.join(import.meta.dir, "..", "test-fixtures", "claude-plugin-corpus.json")

/** 具名失败:占位档不能量,宁可不出数。 */
export class PlaceholderCorpusError extends Error {
  constructor(placeholders: string[]) {
    super(
      `plugin-level agent 仍是占位档(无 text),共 ${placeholders.length} 份 —— 拒绝测量:` +
        `喂占位字节只会得到「假的零」。先按 #848 阶段 2 在真实 marketplace 语料上重生 fixture` +
        `(bun packages/ui-mac/scripts/gen-claude-plugin-corpus-fixture.ts)。首 3 份:` +
        placeholders.slice(0, 3).join(", "),
    )
  }
}

// ── 口径:plugin-level agents(与 census G3 同构,从 fixture 条目而非磁盘推导)────────

function pluginRootsOf(entries: Entry[]): string[] {
  const suffix = "/.claude-plugin/plugin.json"
  return entries
    .filter((e) => e.path.endsWith(suffix))
    .map((e) => e.path.slice(0, -suffix.length))
    .sort()
}

export function splitAgentMd(entries: Entry[]): { pluginLevel: Entry[]; excluded: Entry[] } {
  const roots = pluginRootsOf(entries)
  const pluginLevel: Entry[] = []
  const excluded: Entry[] = []
  for (const e of entries) {
    if (!/(^|\/)agents\/.+\.md$/.test(e.path)) continue
    if (roots.some((r) => e.path.startsWith(`${r}/agents/`))) pluginLevel.push(e)
    else excluded.push(e)
  }
  const byPath = (a: Entry, b: Entry): number => (a.path < b.path ? -1 : 1)
  return { pluginLevel: pluginLevel.sort(byPath), excluded: excluded.sort(byPath) }
}

// ── 顶层键的观测与探针 ────────────────────────────────────────────────────────────

/** 一个顶层键出现:原文行(含缩进续行,供探针复用)+ 观测到的值形状标签。 */
type KeyOccurrence = { key: string; lines: string[]; shape: string; file: string }

/** frontmatter 边界与生产解析器同款(`---` 开头、`\n---` 结束、8192 帽)。抽不出就返回 null。 */
function frontmatterBlockOf(text: string): string | null {
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end === -1 || end > 8192) return null
  return text.slice(3, end).replace(/^\r?\n/, "")
}

/** 观测性形状标签 —— 只描述长相,不宣称语义。 */
function shapeOf(val: string, hasBlock: boolean): string {
  if (!val) return hasBlock ? "block(空值+缩进块)" : "empty"
  if (/^\[.*\]$/.test(val)) return "inline-list"
  if (/^["'].*["']$/.test(val)) return "quoted-scalar"
  if (val === "true" || val === "false") return "boolean"
  if (Number.isFinite(Number(val))) return "numeric"
  if (val.includes(",")) return "comma-list"
  return "plain-scalar"
}

/** 从一份 frontmatter 块里收集顶层键出现(其余顶层行归为 structural,供报告点名)。 */
export function collectKeyOccurrences(file: string, block: string): { keys: KeyOccurrence[]; structural: string[] } {
  const lines = block.split("\n")
  const keys: KeyOccurrence[] = []
  const structural: string[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    if (!raw.trim() || raw.trim().startsWith("#")) {
      i++
      continue
    }
    if (/^\s/.test(raw)) {
      // 顶层游离缩进行(前面没有键收养它)—— 生产解析器在此拒;归 structural。
      structural.push(raw.trim())
      i++
      continue
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw)
    if (!m) {
      structural.push(raw.trim())
      i++
      continue
    }
    const occ: KeyOccurrence = { key: m[1]!, lines: [raw], shape: "", file }
    let j = i + 1
    while (j < lines.length && (/^\s/.test(lines[j]!) || !lines[j]!.trim())) {
      if (!lines[j]!.trim()) break // 空行断块,与生产解析器的逐行推进一致即可(探针只需原文行)
      occ.lines.push(lines[j]!)
      j++
    }
    occ.shape = shapeOf(m[2]!.trim(), occ.lines.length > 1)
    keys.push(occ)
    i = j
  }
  return { keys, structural }
}

export type ProbeResult = { disposition: "accepted" | "ignored" | "rejected"; detail: string }

/** 用生产解析器给单个键定处置:最小文档 = description 探针行 + 该键原文行。 */
export function probeKey(occ: KeyOccurrence): ProbeResult {
  const body = occ.key === "description" ? occ.lines : ["description: probe", ...occ.lines]
  const res = agentMdToEntry(`---\n${body.join("\n")}\n---\nprobe body`)
  if (!res.ok) return { disposition: "rejected", detail: res.reason }
  if (occ.key in res.entry) return { disposition: "accepted", detail: `entry.${occ.key} = ${JSON.stringify(res.entry[occ.key]).slice(0, 60)}` }
  return { disposition: "ignored", detail: "解析成功但键不进条目(如 name:文件名即名字)" }
}

// ── 汇总与渲染 ────────────────────────────────────────────────────────────────────

export type Report = {
  pluginRootCount: number
  files: Array<{ path: string; bytes: number; ok: boolean; reason?: string }>
  excluded: string[]
  byMarketplace: Record<string, number>
  totalBytes: number
  reasonHistogram: Array<[string, number]>
  keyTable: Array<{ key: string; occurrences: number; files: number; shapes: string[]; dispositions: string[] }>
  structural: Array<[string, number]>
}

export function analyze(fixture: Fixture): Report {
  const { pluginLevel, excluded } = splitAgentMd(fixture.entries)
  const placeholders = pluginLevel.filter((e) => !("text" in e)).map((e) => e.path)
  if (placeholders.length > 0) throw new PlaceholderCorpusError(placeholders)

  const files: Report["files"] = []
  const byMarketplace: Record<string, number> = {}
  const reasonCount = new Map<string, number>()
  const perKey = new Map<string, { occ: number; files: Set<string>; shapes: Set<string>; disp: Set<string> }>()
  const structuralCount = new Map<string, number>()
  let totalBytes = 0

  for (const e of pluginLevel) {
    const text = (e as { text: string }).text
    const bytes = Buffer.byteLength(text, "utf8")
    totalBytes += bytes
    const market = e.path.split("/")[0]!
    byMarketplace[market] = (byMarketplace[market] ?? 0) + 1

    const whole = agentMdToEntry(text)
    files.push(whole.ok ? { path: e.path, bytes, ok: true } : { path: e.path, bytes, ok: false, reason: whole.reason })
    if (!whole.ok) reasonCount.set(whole.reason, (reasonCount.get(whole.reason) ?? 0) + 1)

    const block = frontmatterBlockOf(text)
    if (block === null) continue // 整文件拒因已记(missing/unterminated frontmatter),无键可数
    const { keys, structural } = collectKeyOccurrences(e.path, block)
    for (const s of structural) structuralCount.set(s, (structuralCount.get(s) ?? 0) + 1)
    for (const occ of keys) {
      const agg = perKey.get(occ.key) ?? { occ: 0, files: new Set<string>(), shapes: new Set<string>(), disp: new Set<string>() }
      agg.occ += 1
      agg.files.add(occ.file)
      agg.shapes.add(occ.shape)
      const probe = probeKey(occ)
      agg.disp.add(probe.disposition === "rejected" ? `rejected(${probe.detail})` : probe.disposition)
      perKey.set(occ.key, agg)
    }
  }

  return {
    pluginRootCount: pluginRootsOf(fixture.entries).length,
    files,
    excluded: excluded.map((e) => e.path),
    byMarketplace,
    totalBytes,
    reasonHistogram: [...reasonCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    keyTable: [...perKey.entries()]
      .map(([key, a]) => ({ key, occurrences: a.occ, files: a.files.size, shapes: [...a.shapes].sort(), dispositions: [...a.disp].sort() }))
      .sort((a, b) => b.occurrences - a.occurrences || (a.key < b.key ? -1 : 1)),
    structural: [...structuralCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  }
}

function render(report: Report, fixtureSha256: string): string {
  const pass = report.files.filter((f) => f.ok)
  const out: string[] = []
  out.push(`# plugin-level agent frontmatter 分布(#848)`)
  out.push(``)
  out.push(`## 口径`)
  out.push(``)
  out.push(`- 数的是 **plugin-level** \`agents/**/*.md\`(插件根 = 带 \`.claude-plugin/plugin.json\` 的目录),不含别处的 agent。`)
  out.push(`- 插件根 ${report.pluginRootCount} 个;agent 文件 ${report.files.length} 份 / ${report.totalBytes} 字节。`)
  out.push(`- 按 marketplace:${Object.entries(report.byMarketplace).sort().map(([k, v]) => `${k}=${v}`).join("、")}。`)
  out.push(`- 口径外(agents 目录下但非 plugin-level,逐个点名不静默):`)
  for (const p of report.excluded) out.push(`  - ${p}`)
  out.push(`- fixture sha256:\`${fixtureSha256}\``)
  out.push(``)
  out.push(`## 整文件结果(独立复算,生产 agentMdToEntry)`)
  out.push(``)
  out.push(`- **通过 ${pass.length} / ${report.files.length},被拒 ${report.files.length - pass.length}**`)
  out.push(``)
  out.push(`| 拒因(解析器原文) | 份数 |`)
  out.push(`| --- | ---: |`)
  for (const [reason, n] of report.reasonHistogram) out.push(`| \`${reason}\` | ${n} |`)
  out.push(``)
  out.push(`| 文件 | 字节 | 结果 |`)
  out.push(`| --- | ---: | --- |`)
  for (const f of report.files) out.push(`| ${f.path} | ${f.bytes} | ${f.ok ? "✅ ok" : `❌ \`${f.reason}\``} |`)
  out.push(``)
  out.push(`## 顶层键分布(处置 = 生产解析器探针,非另写文法)`)
  out.push(``)
  out.push(`| 键 | 出现次数 | 文件数 | 观测形状 | 生产处置 |`)
  out.push(`| --- | ---: | ---: | --- | --- |`)
  for (const k of report.keyTable)
    out.push(`| \`${k.key}\` | ${k.occurrences} | ${k.files} | ${k.shapes.join("; ")} | ${k.dispositions.join("; ")} |`)
  if (report.structural.length > 0) {
    out.push(``)
    out.push(`### 非 \`key: value\` 的顶层行(生产解析器在此整文件拒)`)
    out.push(``)
    out.push(`| 行(trim 后) | 次数 |`)
    out.push(`| --- | ---: |`)
    for (const [line, n] of report.structural) out.push(`| \`${line.slice(0, 80)}\` | ${n} |`)
  }
  out.push(``)
  return out.join("\n")
}

// ── selftest:内存合成语料,确定性断言全管线 ──────────────────────────────────────

function selftest(): void {
  let failures = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
    if (!cond) failures++
  }
  const t = (text: string): { text: string; mode: number } => ({ text, mode: 0o644 })
  const manifest = (root: string): Entry => ({ path: `${root}/.claude-plugin/plugin.json`, ...t("{}") })

  const entries: Entry[] = [
    manifest("m/p"),
    { path: "m/p/agents/pass.md", ...t("---\ndescription: fine\n---\nbody") },
    { path: "m/p/agents/tools.md", ...t("---\ndescription: d\ntools: Read, Grep\n---\nbody") },
    { path: "m/p/agents/effort.md", ...t("---\ndescription: d\neffort: high\n---\nbody") },
    { path: "m/p/agents/block.md", ...t("---\ndescription: d\nnot a mapping line\n---\nbody") },
    { path: "m/p/agents/named.md", ...t("---\nname: alias\ndescription: d\n---\nbody") },
    { path: "m/p/agents/sub/deep.md", ...t("---\ndescription: d\npermission:\n  bash: deny\n---\nbody") },
    // 口径外两种:技能内层 agents、无清单目录下的 agents
    { path: "m/p/skills/s/agents/inner.md", mode: 0o644, size: 10 },
    { path: "m/loose/agents/x.md", mode: 0o644, size: 10 },
    // marketplace 根本身是插件根(tide-plugin 形态)
    manifest("m2"),
    { path: "m2/agents/direct.md", ...t("---\ndescription: d\n---\nbody") },
  ]
  const fixture: Fixture = { schema: "selftest", roots: ["m", "m2"], entries }

  const { pluginLevel, excluded } = splitAgentMd(entries)
  check("口径:plugin-level 恰 7 份", pluginLevel.length === 7)
  check(
    "口径:技能内层与无清单目录被排除且点名",
    excluded.map((e) => e.path).join(",") === "m/loose/agents/x.md,m/p/skills/s/agents/inner.md",
  )

  const report = analyze(fixture)
  const by = new Map(report.files.map((f) => [f.path, f]))
  check("整文件:pass.md 通过", by.get("m/p/agents/pass.md")!.ok)
  check("整文件:tools 被拒(unsupported key)", by.get("m/p/agents/tools.md")!.reason === "unsupported frontmatter key: tools")
  check("整文件:effort 被拒(unsupported key)", by.get("m/p/agents/effort.md")!.reason === "unsupported frontmatter key: effort")
  check("整文件:非映射行被拒(unparsable)", by.get("m/p/agents/block.md")!.reason?.startsWith("unparsable frontmatter line") === true)
  check("整文件:named.md 通过(name 被忽略)", by.get("m/p/agents/named.md")!.ok)
  check("整文件:嵌套 agents/sub/**.md 计入且 permission 块通过", by.get("m/p/agents/sub/deep.md")!.ok)
  check("整文件:marketplace 根即插件根(m2)计入", by.get("m2/agents/direct.md")!.ok)
  check("汇总:通过 4 / 7(pass、named、sub/deep、m2/direct)", report.files.filter((f) => f.ok).length === 4)

  const key = (k: string) => report.keyTable.find((r) => r.key === k)
  check("键表:tools → rejected", key("tools")!.dispositions.join() .startsWith("rejected"))
  check("键表:tools 形状 = comma-list", key("tools")!.shapes.join() === "comma-list")
  check("键表:name → ignored", key("name")!.dispositions.join() === "ignored")
  check("键表:permission → accepted", key("permission")!.dispositions.join() === "accepted")
  check("键表:description 出现 7 次(每份都有)且 accepted", key("description")!.occurrences === 7 && key("description")!.dispositions.join() === "accepted")
  check("structural:非映射行被点名", report.structural.some(([l]) => l === "not a mapping line"))

  // 占位守卫:任一 plugin-level agent 缺 text ⇒ 具名 loud 失败
  const degraded: Fixture = {
    schema: "selftest",
    roots: ["m"],
    entries: [manifest("m/p"), { path: "m/p/agents/pass.md", mode: 0o644, size: 42 }],
  }
  let threw: unknown
  try {
    analyze(degraded)
  } catch (err) {
    threw = err
  }
  check("占位守卫:降级条目触发 PlaceholderCorpusError", threw instanceof PlaceholderCorpusError)

  console.log(failures === 0 ? "\nselftest: all green" : `\nselftest: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--selftest")) {
  selftest()
} else {
  const raw = fs.readFileSync(FIXTURE_PATH)
  const fixture = JSON.parse(raw.toString("utf8")) as Fixture
  try {
    const report = analyze(fixture)
    console.log(render(report, crypto.createHash("sha256").update(raw).digest("hex")))
  } catch (err) {
    if (err instanceof PlaceholderCorpusError) {
      console.error(`✗ ${err.message}`)
      process.exit(1)
    }
    throw err
  }
}
