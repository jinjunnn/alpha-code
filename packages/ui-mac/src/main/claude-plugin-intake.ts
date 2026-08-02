// REQ-128 Phase 3 `[T1-intake]`(#780):本地 Claude 插件目录的**读取与安装预览**。
//
// 纯读,零写盘。本模块从头到尾不打开任何写句柄、不碰账本、不建事务 —— 它只回答两个问题:
//   ① 用户选的这个目录,是一个 Claude 插件包,还是一份单技能?(分流)
//   ② 如果是插件包,里面每个技能**能不能装**、装不上的**人话原因**是什么。
//
// 三条不可让步的实现纪律(基线 §8),逐条落在本文件里:
//   1. **不解释别人的文法,也不给别人的文法造替身。** 只消费 `plugin.json` 的三个标量
//      (name / version 选填 / description)与 `skills/` 目录;frontmatter 用
//      `parseSkillFrontmatter` 那**一份**;载荷字节只经 `collectImportSkillPayload` 读。
//      认不出的摆放方式 ⇒ 具名为「不支持的布局」,**绝不猜**。
//   2. `local:` 前缀是命名空间保留,不是行为判据 —— 本模块只用它铸 id,不用它判任何行为。
//   3. **降级只许写成降级。** 这条路上没有 admission 的渠道保证;自包含判定是**启发式**,
//      方向保守但会有假阴 —— 判据是「命中以下几类特征之一即拒」,**不是**「保证自包含」。
//
// 与 collector 的分工(基线 §2 注 + §14 R2-a,这是本模块最容易做错的一处):
//   · **内容**只从 `collectImportSkillPayload` 拿(它带 realpath 圈禁 / O_NOFOLLOW / O_NONBLOCK /
//     fstat 帽 / 定长读 / 增长探测)。本模块**不自己 readFileSync 任何技能文件**。
//   · **元数据**(文件名 / mode / symlink / 被排除目录)必须**独立 lstat 扫描**:collector 会
//     静默丢 symlink 与 `.git`/`node_modules`/`__pycache__`,拿它的输出当「源目录长什么样」
//     就是拿实现自己拼的等价链当判据 —— 凡它悄悄丢掉的,判定结构上永远看不见。

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { collectImportSkillPayload, IMPORT_EXCLUDED_DIR_NAMES } from "./ext-fs-installer"
import { parseSkillFrontmatter, SKILL_CONTROL_FIELD_KEYS } from "./ext-import-validate"
import { PACKAGE_ID_RE } from "./ext-package-ledger-v3"

/** 事务的**真界**(`ext-transaction.ts:650` 的 `plan.items.length > 64`)。
 *  刻意**不是**发布端的 `maxComponents: 16` —— 本路根本不过 decoder,拿 16 立闸是前提为假的闸。 */
export const LOCAL_PACKAGE_MAX_COMPONENTS = 64

/** 本期只认这一种技能布局。深度实测恒为 2,真实语料 159/162 无一例外。 */
const STANDARD_SKILL_DIR = "skills"

// ── 原因码(全部具名,一条都不静默)────────────────────────────────────────────────────────

/** 本版本还不认识的技能摆放方式。**不许**落回「文件夹内没有 SKILL.md」——
 *  那是一句与真因毫无关系的错误信息,用户据它做不出任何正确动作。 */
export type LocalPackageLayoutCode =
  /** 没有 `.claude-plugin/plugin.json`,但 `skills/<n>/SKILL.md` 成立(官方现役形态:receipts / session-report)。 */
  | "manifestless-plugin-dir"
  /** `.claude/skills/<n>/SKILL.md`(插件根没有 `skills/`)。 */
  | "dot-claude-skills-dir"
  /** `skills/` 之外的目录里另有 SKILL.md(如 `workflow-skills/`)—— 上游是否把它当技能加载,我们判断不了,不猜。 */
  | "non-standard-skill-dir"
  /** `.claude-plugin/` 里只有 `marketplace.json`、没有 `plugin.json`(装成插件的 marketplace 仓)。 */
  | "marketplace-json-only"
  /** 插件根**自己就是**一个技能(根级 SKILL.md)。 */
  | "plugin-root-is-skill"
  /** `plugin.json` 用 `skills` 字段声明了自定义技能目录(本机 183 份 manifest 里 0 次,本期不实现)。 */
  | "manifest-declared-skills-field"

/** 这一版不安装的组件类型。**不靠「没接线所以到不了」**,逐类具名拒绝。 */
export type LocalPackageUnsupportedComponentType = "commands" | "agents" | "hooks" | "mcp-config"

/** 技能装不上的原因。**可枚举、可点名**;preview 逐条呈现,不折叠成一句「失败」。 */
export type LocalPackageSkipCode =
  /** frontmatter 读不出(name/description 缺失或不合法、未闭合、无 --- 头)。 */
  | "frontmatter-unreadable"
  /** 载荷读不出(超帽、symlink 竞态、非常规文件…)—— 原文来自 collector,不改写。 */
  | "payload-unreadable"
  /** 带 Alpha 没有对应语义的调用控制字段(owner 裁决 C)。 */
  | "control-field-unsupported"
  /** 目录内有带可执行位的文件(owner 裁决 A)。 */
  | "not-self-contained-executable-bit"
  /** 目录内有符号链接(owner 裁决 A)。collector 会静默丢掉它们 ⇒ 只有独立扫描看得见。 */
  | "not-self-contained-symlink"
  /** 目录内含 `.git` / `node_modules` / `__pycache__`(基线 §14 R2-a)。
   *  collector **必定静默跳过**它们 ⇒ 不在这里具名拒绝,就是「预览接受、装完缺件」。 */
  | "not-self-contained-excluded-directory"
  /** SKILL.md 引用 `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` —— 装过去解析不到。 */
  | "not-self-contained-plugin-root-variable"
  /** SKILL.md 引用了本目录解析不到、而插件根解析得到的文件。 */
  | "not-self-contained-outside-reference"
  /** SKILL.md 用 `../` 引用了目录之外(常见:引用兄弟技能)。 */
  | "not-self-contained-parent-reference"
  /** 整包组件数超过事务真界 64 ⇒ 在 preview 期就拒,一条都不装。 */
  | "package-component-limit-exceeded"

/** 整包装不成的原因。**「一个都装不上」是多数可达终态**(真实语料 10/40 个插件如此),
 *  必须给具名终态,不是空成功。 */
export type LocalPackageBlockedCode =
  | "no-installable-component"
  | "package-component-limit-exceeded"
  | "manifest-unreadable"

/** 各类原因码 → 人话。UI 直接可用(零票号、零开发术语)。 */
const SKIP_DETAIL: Record<LocalPackageSkipCode, string> = {
  "frontmatter-unreadable": "这个技能的说明我们读不出来",
  "payload-unreadable": "这个技能的文件读不出来",
  "control-field-unsupported": "这个技能带了我们这边没有对应功能的开关,装过去它的行为会变",
  "not-self-contained-executable-bit": "这个技能带了可执行脚本,装过去不会保留执行权限",
  "not-self-contained-symlink": "这个技能里有快捷方式(符号链接),装过去会缺件",
  "not-self-contained-excluded-directory": "这个技能的文件夹里有构建产物或版本库数据,装过去会缺件",
  "not-self-contained-plugin-root-variable": "这个技能要用到整个插件目录里的东西,单独装过去会缺件",
  "not-self-contained-outside-reference": "这个技能引用了它自己文件夹以外的文件,装过去会缺件",
  "not-self-contained-parent-reference": "这个技能引用了同一插件里的别的技能,装过去会缺件",
  "package-component-limit-exceeded": "这一包技能太多,一次装不下",
}

const LAYOUT_DETAIL: Record<LocalPackageLayoutCode, string> = {
  "manifestless-plugin-dir": "这个文件夹没有插件说明文件,我们这一版还不认识这种摆法",
  "dot-claude-skills-dir": "技能放在 .claude/skills 里,我们这一版只认 skills 目录",
  "non-standard-skill-dir": "这个目录里也有技能,但不在 skills 目录下,我们这一版不读它",
  "marketplace-json-only": "这是一个插件市场目录,不是单个插件",
  "plugin-root-is-skill": "这个插件根目录本身就是一个技能,我们这一版还不认识这种摆法",
  "manifest-declared-skills-field": "插件说明里自己声明了技能目录,我们这一版还不读这个声明",
}

const UNSUPPORTED_COMPONENT_DETAIL: Record<LocalPackageUnsupportedComponentType, string> = {
  commands: "这个插件带了斜杠命令,本版本不安装",
  agents: "这个插件带了子 agent,本版本不安装",
  hooks: "这个插件带了钩子,本版本不安装",
  "mcp-config": "这个插件带了 MCP 服务配置,本版本不安装",
}

/** 原因码的固定优先级 —— 决定 preview 里哪一条当标题。顺序固定 = 结果确定,不随文件系统枚举顺序变。 */
const SKIP_PRIORITY: readonly LocalPackageSkipCode[] = [
  "package-component-limit-exceeded",
  "frontmatter-unreadable",
  "payload-unreadable",
  "control-field-unsupported",
  "not-self-contained-symlink",
  "not-self-contained-excluded-directory",
  "not-self-contained-executable-bit",
  "not-self-contained-parent-reference",
  "not-self-contained-plugin-root-variable",
  "not-self-contained-outside-reference",
]

// ── 预览形状 ──────────────────────────────────────────────────────────────────────────────

export type LocalPackageComponentV1 = {
  readonly kind: "skill"
  /** frontmatter 里的 name;读不出时退回目录名(只用于显示,不用于安装)。 */
  readonly name: string
  /** 相对插件根的 POSIX 路径。 */
  readonly dir: string
  readonly disposition: "install" | "skip"
  /** 命中的**全部**原因(按固定优先级排序)。装得上时为空数组。 */
  readonly reasonCodes: readonly LocalPackageSkipCode[]
  /** 逐条人话。与 `reasonCodes` 同序同长。 */
  readonly reasons: readonly string[]
  /** 只对 `install` 有值:载荷文件数 / 字节数 / 内容摘要。 */
  readonly fileCount: number | null
  readonly byteCount: number | null
  readonly contentDigest: string | null
}

export type LocalPackageLayoutIssueV1 = {
  readonly code: LocalPackageLayoutCode
  /** 相对插件根的 POSIX 路径("" = 根本身)。 */
  readonly at: string
  readonly detail: string
}

export type LocalPackageUnsupportedComponentV1 = {
  readonly type: LocalPackageUnsupportedComponentType
  readonly at: string
  readonly detail: string
}

export type LocalPackagePreviewV1 = {
  readonly schema: "local-claude-plugin-preview/v1"
  /** `local:<slug>`。manifest 读不出时为 null(此时 disposition 恒 blocked)。 */
  readonly packageId: string | null
  readonly name: string
  /** **选填** —— 真实语料 27/62 的 manifest 没有它,当必填会拒掉 44% 的插件。 */
  readonly version: string | null
  readonly description: string
  readonly disposition: "installable" | "blocked"
  readonly blockedReasonCode: LocalPackageBlockedCode | null
  readonly blockedReason: string | null
  readonly components: readonly LocalPackageComponentV1[]
  readonly installableCount: number
  readonly unsupportedComponentTypes: readonly LocalPackageUnsupportedComponentV1[]
  readonly unsupportedLayouts: readonly LocalPackageLayoutIssueV1[]
  /** 只由 install 组件派生;一个都装不上时为 null。 */
  readonly snapshotDigest: string | null
  /** K19:重复导入必须在**确认之前**说清「先移除整包」。 */
  readonly duplicateImportNotice: string | null
  readonly limits: { readonly maxComponents: number; readonly skillCandidates: number }
}

export type ImportDirIntakeV1 =
  /** 不是插件目录 ⇒ 原路走既有单技能导入,**行为逐字不变**。 */
  | { readonly route: "single-skill" }
  | { readonly route: "local-claude-plugin"; readonly preview: LocalPackagePreviewV1 }

export type LocalPackageIntakeOptions = {
  /** 已装的本地包 id 集合(由调用方从 V3 账本读)。命中即在确认之前给出「先移除整包」。 */
  readonly installedPackageIds?: ReadonlySet<string>
}

// ── 独立 lstat 扫描(**不是** collector 的输出)────────────────────────────────────────────

type IndependentScan = {
  /** 常规文件:相对路径 + mode。 */
  readonly files: ReadonlyArray<{ rel: string; mode: number }>
  /** 符号链接(collector 会静默丢掉,只有这里看得见)。 */
  readonly symlinks: readonly string[]
  /** collector 必定静默跳过的目录(基线 §14 R2-a)。 */
  readonly excludedDirs: readonly string[]
  readonly failed: string | null
}

/** 对源目录做**独立于 collector** 的 lstat 递归扫描。只读元数据,不读内容。
 *  排除集来自 `IMPORT_EXCLUDED_DIR_NAMES` 这**一份**真源 —— 两处各写一份就是手写替身。 */
function independentLstatScan(dir: string): IndependentScan {
  const files: Array<{ rel: string; mode: number }> = []
  const symlinks: string[] = []
  const excludedDirs: string[] = []
  const walk = (rel: string, depth: number): string | null => {
    if (depth > 32) return "目录层级过深"
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch (error) {
      return error instanceof Error ? error.message : "目录读取失败"
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        symlinks.push(childRel)
        continue
      }
      if (entry.isDirectory()) {
        if (IMPORT_EXCLUDED_DIR_NAMES.includes(entry.name)) {
          excludedDirs.push(childRel)
          continue
        }
        const err = walk(childRel, depth + 1)
        if (err) return err
        continue
      }
      if (!entry.isFile()) continue
      let st: fs.Stats
      try {
        st = fs.lstatSync(path.join(dir, childRel))
      } catch {
        continue
      }
      files.push({ rel: childRel, mode: st.mode })
    }
    return null
  }
  const failed = walk("", 0)
  return { files, symlinks, excludedDirs, failed }
}

// ── SKILL.md 里的外部引用抽取(启发式,方向保守)──────────────────────────────────────────

/** 插件根变量。装过去解析不到 ⇒ 缺件。 */
const PLUGIN_ROOT_VARS = /\$\{?(?:CLAUDE_PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}?/

/** 路径形 token:`./x`、`../x`,或 `a/b.ext`。
 *  **这是启发式**:抓不到运行期拼出来的路径、抓不到写在 `references/*.md` 里的路径。
 *  方向保守(漏判 = 装了一个可能缺件的技能),但**不许**把它写成「保证自包含」。 */
const PATH_TOKEN = /(?:\.{1,2}\/)[\w.@/-]+|(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}/g

type ReferenceScan = { pluginRootVariable: boolean; parentReference: boolean; outsideReference: boolean }

function scanSkillReferences(skillMdText: string, skillDir: string, pluginRoot: string): ReferenceScan {
  const out: ReferenceScan = { pluginRootVariable: false, parentReference: false, outsideReference: false }
  if (PLUGIN_ROOT_VARS.test(skillMdText)) out.pluginRootVariable = true
  const exists = (p: string): boolean => {
    try {
      fs.lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  for (const token of new Set(skillMdText.match(PATH_TOKEN) ?? [])) {
    if (token.startsWith("../")) {
      const abs = path.resolve(skillDir, token)
      if (!abs.startsWith(skillDir + path.sep) && exists(abs)) out.parentReference = true
      continue
    }
    const clean = token.replace(/^\.\//, "")
    if (exists(path.join(skillDir, clean))) continue // 在自己目录里解析得到 ⇒ 自包含
    if (exists(path.join(pluginRoot, clean))) out.outsideReference = true
  }
  return out
}

// ── 布局判定 ──────────────────────────────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** `<dir>/<sub>/<n>/SKILL.md` 形态的技能目录名(排序后返回,结果确定)。 */
function skillDirNamesUnder(root: string, sub: string): string[] {
  const base = path.join(root, sub)
  if (!isDir(base)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => !e.isSymbolicLink() && e.isDirectory() && isRegularFile(path.join(base, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort()
}

/** 除 `skills/` 与 `.claude/skills/` 之外,还有哪些顶层目录里藏着 `<n>/SKILL.md`。
 *  真实语料里 `figma` 的 `workflow-skills/` 是实例 —— 上游是否把它当技能加载我们判断不了,**不猜**。 */
function nonStandardSkillDirs(root: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue
    if (e.name === STANDARD_SKILL_DIR || e.name === ".claude" || e.name === ".claude-plugin") continue
    if (IMPORT_EXCLUDED_DIR_NAMES.includes(e.name)) continue
    if (skillDirNamesUnder(root, e.name).length > 0) out.push(e.name)
  }
  return out.sort()
}

type Manifest = { name: string; version: string | null; description: string; declaresSkillsField: boolean }

/** 只消费三个标量 + 一个存在性判断。**不解析别人的文法**:结构不对就当没有 manifest。 */
function readManifest(root: string): Manifest | null {
  const p = path.join(root, ".claude-plugin", "plugin.json")
  if (!isRegularFile(p)) return null
  let raw: string
  try {
    raw = fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const name = typeof obj["name"] === "string" ? obj["name"] : ""
  if (!name) return null
  return {
    name,
    version: typeof obj["version"] === "string" && obj["version"] ? obj["version"] : null, // **选填**
    description: typeof obj["description"] === "string" ? obj["description"] : "",
    declaresSkillsField: "skills" in obj,
  }
}

/** manifest name → `local:<slug>`。铸不出合法 id 就交出 null,**不硬凑**。 */
function mintPackageId(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 128)
  if (!slug) return null
  const id = `local:${slug}`
  return PACKAGE_ID_RE.test(id) ? id : null
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

// ── 分流点 ────────────────────────────────────────────────────────────────────────────────

/** 用户选的目录是不是一个 Claude 插件包?
 *
 *  判据刻意**不是**「有没有 plugin.json」:官方现役的 manifestless 插件(receipts / session-report)
 *  与只带 marketplace.json 的目录都会被那条规则漏掉,然后落回单技能路径,报出一句
 *  「文件夹内没有 SKILL.md」—— 与真因毫无关系。
 *
 *  **保守方向**:根级 SKILL.md 且**没有** `.claude-plugin/` 的目录一律留在既有单技能路径上,
 *  行为逐字不变(那正是今天 `importSkillFolder` 服务的形态)。 */
function isLocalClaudePluginDir(root: string): boolean {
  if (isRegularFile(path.join(root, "SKILL.md")) && !isDir(path.join(root, ".claude-plugin"))) return false
  if (isRegularFile(path.join(root, ".claude-plugin", "plugin.json"))) return true
  if (isRegularFile(path.join(root, ".claude-plugin", "marketplace.json"))) return true
  if (skillDirNamesUnder(root, STANDARD_SKILL_DIR).length > 0) return true
  if (skillDirNamesUnder(root, path.join(".claude", STANDARD_SKILL_DIR)).length > 0) return true
  return false
}

/** REQ-128 T1 的入口:分流 + (是插件包时)清点。**纯读,零写盘。** */
export function intakeImportDir(srcDir: string, options: LocalPackageIntakeOptions = {}): ImportDirIntakeV1 {
  if (typeof srcDir !== "string" || !path.isAbsolute(srcDir)) return { route: "single-skill" }
  let real: string
  try {
    real = fs.realpathSync(srcDir)
    if (!fs.statSync(real).isDirectory()) return { route: "single-skill" }
  } catch {
    return { route: "single-skill" }
  }
  if (!isLocalClaudePluginDir(real)) return { route: "single-skill" }
  return { route: "local-claude-plugin", preview: previewLocalClaudePlugin(real, options) }
}

// ── 清点 ──────────────────────────────────────────────────────────────────────────────────

/** 对一个已判定为 Claude 插件包的目录做**纯读**清点,产 `LocalPackagePreviewV1`。 */
export function previewLocalClaudePlugin(root: string, options: LocalPackageIntakeOptions = {}): LocalPackagePreviewV1 {
  const manifest = readManifest(root)
  const layouts: LocalPackageLayoutIssueV1[] = []
  const layout = (code: LocalPackageLayoutCode, at: string): void => {
    layouts.push({ code, at, detail: LAYOUT_DETAIL[code] })
  }

  // ── 布局普查:每一类不支持的摆法都要具名落地,一条都不静默 ──
  const standardNames = skillDirNamesUnder(root, STANDARD_SKILL_DIR)
  if (!manifest) {
    if (isRegularFile(path.join(root, ".claude-plugin", "marketplace.json"))) layout("marketplace-json-only", ".claude-plugin/marketplace.json")
    else layout("manifestless-plugin-dir", "")
  } else if (manifest.declaresSkillsField) {
    layout("manifest-declared-skills-field", ".claude-plugin/plugin.json")
  }
  if (isRegularFile(path.join(root, "SKILL.md"))) layout("plugin-root-is-skill", "SKILL.md")
  for (const n of skillDirNamesUnder(root, path.join(".claude", STANDARD_SKILL_DIR))) layout("dot-claude-skills-dir", `.claude/skills/${n}`)
  for (const d of nonStandardSkillDirs(root)) layout("non-standard-skill-dir", d)

  // ── 这一版不安装的组件类型:逐类具名,不靠「没接线所以到不了」 ──
  const unsupportedComponentTypes: LocalPackageUnsupportedComponentV1[] = []
  const namedComponent = (type: LocalPackageUnsupportedComponentType, at: string, present: boolean): void => {
    if (present) unsupportedComponentTypes.push({ type, at, detail: UNSUPPORTED_COMPONENT_DETAIL[type] })
  }
  namedComponent("commands", "commands", isDir(path.join(root, "commands")))
  namedComponent("agents", "agents", isDir(path.join(root, "agents")))
  namedComponent("hooks", "hooks", isDir(path.join(root, "hooks")))
  namedComponent("mcp-config", ".mcp.json", isRegularFile(path.join(root, ".mcp.json")))

  // ── G11:整包组件数超过事务真界 64 ⇒ **preview 期**整包拒,一条都不装 ──
  const overLimit = standardNames.length > LOCAL_PACKAGE_MAX_COMPONENTS

  const components: LocalPackageComponentV1[] = []
  for (const name of standardNames) {
    const dirRel = `${STANDARD_SKILL_DIR}/${name}`
    if (overLimit) {
      components.push(skipped(name, dirRel, ["package-component-limit-exceeded"]))
      continue
    }
    components.push(judgeSkill(root, dirRel, name))
  }

  const installable = components.filter((c) => c.disposition === "install")
  const packageId = manifest ? mintPackageId(manifest.name) : null

  let blockedReasonCode: LocalPackageBlockedCode | null = null
  if (overLimit) blockedReasonCode = "package-component-limit-exceeded"
  else if (!manifest || !packageId) blockedReasonCode = "manifest-unreadable"
  else if (installable.length === 0) blockedReasonCode = "no-installable-component"

  const blockedReason =
    blockedReasonCode === "package-component-limit-exceeded"
      ? `这一包有 ${standardNames.length} 个技能,超过一次能装的上限(${LOCAL_PACKAGE_MAX_COMPONENTS} 个),本版本不装`
      : blockedReasonCode === "manifest-unreadable"
        ? "这个文件夹的插件说明我们读不出来,认不出它是哪个插件"
        : blockedReasonCode === "no-installable-component"
          ? "这个插件里没有本版本能装的技能"
          : null

  const snapshotDigest =
    installable.length === 0
      ? null
      : sha256(installable.map((c) => `${c.name}\u0000${c.dir}\u0000${c.contentDigest}`).join("\n"))

  const duplicateImportNotice =
    packageId && options.installedPackageIds?.has(packageId)
      ? "这个插件已经装过了。要更新它,请先移除整包,再重新导入。"
      : null

  return {
    schema: "local-claude-plugin-preview/v1",
    packageId,
    name: manifest?.name ?? path.basename(root),
    version: manifest?.version ?? null,
    description: manifest?.description ?? "",
    disposition: blockedReasonCode ? "blocked" : "installable",
    blockedReasonCode,
    blockedReason,
    components,
    installableCount: installable.length,
    unsupportedComponentTypes,
    unsupportedLayouts: layouts,
    snapshotDigest,
    duplicateImportNotice,
    limits: { maxComponents: LOCAL_PACKAGE_MAX_COMPONENTS, skillCandidates: standardNames.length },
  }
}

function skipped(name: string, dir: string, codes: LocalPackageSkipCode[]): LocalPackageComponentV1 {
  const ordered = SKIP_PRIORITY.filter((c) => codes.includes(c))
  return {
    kind: "skill",
    name,
    dir,
    disposition: "skip",
    reasonCodes: ordered,
    reasons: ordered.map((c) => SKIP_DETAIL[c]),
    fileCount: null,
    byteCount: null,
    contentDigest: null,
  }
}

/** 判一个技能目录能不能装。**命中的全部原因一起交出**,不是只报第一条 ——
 *  真实语料里 3 个技能同时踩自包含与控制字段两类,只报一条会让用户以为改掉它就能装。 */
function judgeSkill(root: string, dirRel: string, dirName: string): LocalPackageComponentV1 {
  const skillDir = path.join(root, dirRel)
  const codes: LocalPackageSkipCode[] = []

  // ① 独立 lstat 扫描(**不是** collector 的输出):symlink / 可执行位 / 被排除目录。
  const scan = independentLstatScan(skillDir)
  if (scan.symlinks.length > 0) codes.push("not-self-contained-symlink")
  if (scan.excludedDirs.length > 0) codes.push("not-self-contained-excluded-directory")
  if (scan.files.some((f) => (f.mode & 0o111) !== 0)) codes.push("not-self-contained-executable-bit")

  // ② 内容**只**经硬化过的 collector 读。本函数不自己开任何文件句柄读技能内容。
  const payload = collectImportSkillPayload(skillDir)
  if (!payload.ok) {
    codes.push(payload.reason.startsWith("非法 frontmatter") ? "frontmatter-unreadable" : "payload-unreadable")
    return skipped(dirName, dirRel, codes)
  }
  const skillMd = payload.files.find((f) => f.path === "SKILL.md")
  if (!skillMd) {
    codes.push("payload-unreadable")
    return skipped(dirName, dirRel, codes)
  }
  const text = skillMd.data.toString("utf8")

  // ③ 控制字段:判据是**顶层键在不在**,与它有没有标量值无关(块式与标量式一视同仁)。
  const fm = parseSkillFrontmatter(text)
  if (!fm.ok) {
    codes.push("frontmatter-unreadable")
    return skipped(dirName, dirRel, codes)
  }
  if (fm.keys.some((k) => SKILL_CONTROL_FIELD_KEYS.includes(k))) codes.push("control-field-unsupported")

  // ④ 外部引用(启发式,方向保守 —— 不保证自包含,只保证命中这几类特征即拒)。
  const refs = scanSkillReferences(text, skillDir, root)
  if (refs.pluginRootVariable) codes.push("not-self-contained-plugin-root-variable")
  if (refs.parentReference) codes.push("not-self-contained-parent-reference")
  if (refs.outsideReference) codes.push("not-self-contained-outside-reference")

  if (codes.length > 0) return skipped(fm.name, dirRel, codes)

  const byteCount = payload.files.reduce((n, f) => n + f.data.length, 0)
  const contentDigest = sha256(payload.files.map((f) => `${f.path}\u0000${sha256(f.data)}`).sort().join("\n"))
  return {
    kind: "skill",
    name: fm.name,
    dir: dirRel,
    disposition: "install",
    reasonCodes: [],
    reasons: [],
    fileCount: payload.files.length,
    byteCount,
    contentDigest,
  }
}
