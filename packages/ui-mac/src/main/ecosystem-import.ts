// ecosystem-import — REQ-063(ADR-024):外部生态继承 default-deny 的「同意 = 安装期转换导入」后端。
//
// 上游静默继承面只有两类(源码钉死,skill/index.ts:21-22 + instruction.ts:62-66):
//   skill(~/.claude/skills、~/.agents/skills、项目同名目录)与 CLAUDE.md(全局 + 项目)。
// default-deny 由 applyEcosystemDefaultDeny 注入上游进程级 flag;本模块承载 consent 之后的
// **转换导入**(ADR-023 一脉:产物为原生 alpha 资产,与外部目录脱钩 —— 快照语义,重导入是唯一
// 更新通道):
//   - skill  → importSkillFolder(既有 REQ-033 管线:frontmatter 校验/防逃逸/receipts),
//              origin 标 imported-claude / imported-agents 可溯源;
//   - 项目 CLAUDE.md → AGENTS.md(引擎原生指令约定,零新通道;已有 AGENTS.md → loud 让用户手动
//              合并,绝不静默覆盖/追加,C28);
//   - 全局 CLAUDE.md → `~/.alpha/instructions/imported-claude-code.md`(sidecar injectAlphaConfig
//              扫描该目录并入 instructions —— alpha 原生通道)。
//
// 记账:项目决策 = `.alpha/prefs.json` 的 externalImport(版本化,REQ-060 extensionsConsent 同款);
// 全局一次性迁移门 = `~/.alpha/ecosystem-import.json`(marker,防重复弹)。

import * as fs from "node:fs"
import * as path from "node:path"
import { alphaGlobalRoot } from "./alpha-installs"
import { importSkillFolder } from "./ext-fs-installer"
import type { InstallTarget } from "../preload/types"

export const EXTERNAL_IMPORT_VERSION = 1

/** T1:default-deny flags(set-if-unset;逃生 ALPHA_ECOSYSTEM_INHERIT=1 不注入)。 */
export function applyEcosystemDefaultDeny(env: NodeJS.ProcessEnv): void {
  if (env.ALPHA_ECOSYSTEM_INHERIT === "1") return
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS ??= "1"
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ??= "1"
}

export function ecosystemInheritEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALPHA_ECOSYSTEM_INHERIT === "1"
}

export type ExternalSkill = { name: string; dir: string; source: "claude" | "agents" }
export type ExternalContent = { skills: ExternalSkill[]; claudeMd: string | null }

/** 目录下的候选技能(<root>/<name>/SKILL.md;symlink 跟随,同上游 glob 语义)。 */
function scanSkillsDir(root: string, source: "claude" | "agents"): ExternalSkill[] {
  const out: ExternalSkill[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const dir = path.join(root, e.name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue // stat 跟随 symlink
      if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue
      out.push({ name: e.name, dir, source })
    } catch {
      /* 坏条目跳过 */
    }
  }
  return out
}

/** 检测一个「根」下的外来内容(只报上游真会继承的范围,instruction.ts:60-68 钉死):
 *  项目根 = <project>(CLAUDE.md 在项目根);全局根 = os home(CLAUDE.md 在 ~/.claude/CLAUDE.md)。 */
export function detectExternal(root: string, scope: "project" | "global"): ExternalContent {
  const skills = [
    ...scanSkillsDir(path.join(root, ".claude", "skills"), "claude"),
    ...scanSkillsDir(path.join(root, ".agents", "skills"), "agents"),
  ]
  const candidate = scope === "project" ? path.join(root, "CLAUDE.md") : path.join(root, ".claude", "CLAUDE.md")
  let claudeMd: string | null = null
  try {
    if (fs.statSync(candidate).isFile()) claudeMd = candidate
  } catch {
    /* absent */
  }
  return { skills, claudeMd }
}

export type ImportOutcome = {
  importedSkills: string[]
  skipped: Array<{ name: string; reason: string }>
  claudeMd: "agents-md-created" | "agents-md-exists" | "instructions-file" | "none"
}

/** skills 转换导入(项目/全局同一管线,只差 target 与 origin)。 */
export function importExternalSkills(
  skills: readonly ExternalSkill[],
  target: InstallTarget,
): Pick<ImportOutcome, "importedSkills" | "skipped"> {
  const importedSkills: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  for (const s of skills) {
    const r = importSkillFolder(s.dir, target, s.source === "claude" ? "imported-claude" : "imported-agents")
    if (r.ok) importedSkills.push(r.name ?? s.name)
    else skipped.push({ name: s.name, reason: r.reason })
  }
  return { importedSkills, skipped }
}

/** 项目 CLAUDE.md → AGENTS.md(引擎原生约定)。已有 AGENTS.md → 不动 + 如实报告(C28)。 */
export function importProjectClaudeMd(projectDir: string, claudeMdPath: string): "agents-md-created" | "agents-md-exists" {
  const agentsMd = path.join(projectDir, "AGENTS.md")
  if (fs.existsSync(agentsMd)) return "agents-md-exists"
  const body = fs.readFileSync(claudeMdPath, "utf8")
  const provenance = `<!-- imported from ${path.basename(path.dirname(claudeMdPath)) === ".claude" ? ".claude/CLAUDE.md" : "CLAUDE.md"} by alpha-code (REQ-063 snapshot import; re-import to refresh) -->\n\n`
  fs.writeFileSync(agentsMd, provenance + body)
  return "agents-md-created"
}

/** 全局 CLAUDE.md → `~/.alpha/instructions/imported-claude-code.md`(sidecar 注入通道)。 */
export function importGlobalClaudeMd(claudeMdPath: string): string {
  const dir = path.join(alphaGlobalRoot(), "instructions")
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, "imported-claude-code.md")
  fs.writeFileSync(dest, fs.readFileSync(claudeMdPath, "utf8"))
  return dest
}

/** `~/.alpha/instructions/*.md` 清单(sidecar injectAlphaConfig 消费;缺目录 = 空)。 */
export function listAlphaInstructionFiles(root: string = alphaGlobalRoot()): string[] {
  const dir = path.join(root, "instructions")
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

// ── 项目决策记账(T2;REQ-060 extensionsConsent 同款版本化)────────────────────────
import type { ProjectPrefs } from "./alpha-cloud-consent"

export type ExternalImportPref = { version: number; decision: "imported" | "declined"; at: string }

export function hasExternalImportDecision(prefs: ProjectPrefs): boolean {
  const p = prefs.externalImport as ExternalImportPref | undefined
  return p?.version === EXTERNAL_IMPORT_VERSION
}

export function withExternalImportDecision(prefs: ProjectPrefs, decision: "imported" | "declined", iso: string): ProjectPrefs {
  return { ...prefs, externalImport: { version: EXTERNAL_IMPORT_VERSION, decision, at: iso } }
}

// ── 全局一次性迁移门 marker(T4)────────────────────────────────────────────────
export type GlobalGateMarker = {
  version: number
  decision: "imported" | "declined"
  at: string
  imported?: string[]
  skipped?: Array<{ name: string; reason: string }>
}

const markerPath = () => path.join(alphaGlobalRoot(), "ecosystem-import.json")

export function readGlobalGateMarker(): GlobalGateMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(), "utf8")) as GlobalGateMarker
    return m && typeof m === "object" && m.version === EXTERNAL_IMPORT_VERSION ? m : null
  } catch {
    return null
  }
}

export function writeGlobalGateMarker(m: GlobalGateMarker): void {
  fs.mkdirSync(alphaGlobalRoot(), { recursive: true })
  const tmp = markerPath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, markerPath())
}
