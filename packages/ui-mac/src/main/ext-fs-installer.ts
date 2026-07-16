// Extension Hub file installer (main process) — REQ-018 T2 rework. User-authored / catalog skills
// and agents now land in the ALPHA truth root (`~/.alpha/{skills,agents}` for global scope,
// `<project>/.alpha/...` for project scope) and reach the engine through the `.opencode` symlink
// bridge (alpha-bridge.ts, REQ-004-validated). Every successful install writes a receipt
// (alpha-installs.ts) recording the exact files it owns, so installed-state/uninstall/update work.
// Legacy behavior (writing the shared XDG config dir) is gone — migration of old installs is T3
// (`ALPHA_LEGACY_INSTALL_ROOT=1` keeps the old root for escape).
//
// Security unchanged (ADR-014 §8): names validated, every path confined to its root via the
// realpath anti-escape walk; asset keys confined to resources/skills.

import { execFile } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { opencodeHomeDir, unbridgeItem } from "./alpha-bridge"
import { agentMdToEntry } from "./agent-md-entry"
import { persistAgentEntry, readAgentEntry, readAgentEntryStrict, removeAgentEntry } from "./ext-config"
import { alphaGlobalRoot, removeReceipt } from "./alpha-installs"
import { tryGetAlphaEnvironment } from "./alpha-environment"
import { projectScopeIdentity, type ScopeIdentity } from "./ext-receipt-v2"
import { checkUncuratedConflict, recordUncuratedInstall, type UncuratedOrigin } from "./ext-uncurated-record"
import { alphaRoot, ensureAlphaScaffold } from "./alpha-workdir"
import type { InstallMeta, InstallReceipt, InstallTarget } from "../preload/types"
import { parseSkillFrontmatter, validGitUrl } from "./ext-import-validate"
import { persistPluginPath } from "./ext-config"

export type FsResult = { ok: true; files?: string[] } | { ok: false; reason: string }

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function opencodeConfigDir(): string {
  // REQ-017:与 ext-config.userConfigDir / 上游 core/global.ts 同规则(OPENCODE_CONFIG_DIR >
  // XDG_CONFIG_HOME/opencode > ~/.config/opencode)。REQ-018 起仅用于 legacy 逃生根(见下)。
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

// REQ-018 逃生阀:置 1 回到旧行为(写共享 XDG 根,不桥接、不记账)。
function legacyRootActive(): boolean {
  return process.env.ALPHA_LEGACY_INSTALL_ROOT === "1"
}

// Resolve a target inside `root` and assert (via realpath of the existing ancestor) that it can't
// escape that root through symlinks or `..`.
function safeResolveUnder(root: string, ...segments: string[]): string | null {
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    const real = fs.realpathSync(probe)
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      // before the root exists, the nearest ancestor may be its (legitimate) parent dir
      const parentOfRoot = path.dirname(root)
      if (!(fs.existsSync(parentOfRoot) && real === fs.realpathSync(parentOfRoot))) return null
    }
  } catch {
    return null
  }
  return target
}

// identity:REQ-099 #306 —— 未策展落账要携带安装时点的 scope identity(project = realpath+hash,
// 不是只有 label;Codex 裁决风险点),resolveRoots 一次算好随 Roots 传递。
type Roots = { alphaDir: string; opencodeDir: string; scope: "global" | "project"; identity: ScopeIdentity }

function resolveRoots(target: InstallTarget | undefined): Roots | { error: string } {
  const t = target ?? { scope: "global" as const }
  if (t.scope === "global") {
    return { alphaDir: alphaGlobalRoot(), opencodeDir: opencodeHomeDir(), scope: "global", identity: { kind: "global" } }
  }
  if (typeof t.projectDir !== "string") return { error: "invalid project directory" }
  const root = alphaRoot(t.projectDir)
  if (!root) return { error: `invalid project directory: ${t.projectDir}` }
  if (!ensureAlphaScaffold(t.projectDir)) return { error: "failed to prepare .alpha" }
  const identity = projectScopeIdentity(t.projectDir)
  if (!identity.ok) return { error: `fail closed: ${identity.reason}` }
  return { alphaDir: root, opencodeDir: path.join(t.projectDir, ".opencode"), scope: "project", identity: identity.scope }
}

type LedgerOutcome = { ok: true; warning?: string } | { ok: false; reason: string }

/** REQ-099 #306 / #354:安装落账分流 —— catalog(meta.catalogId)的账本所有权**完全归 planner**
 *  (v2 upsert 提交面已 fail-closed,v1 视图由 toV1Receipt 锁步派生;此前的 eager v1 兜底随
 *  fail-open 一并下线),本函数对 catalog 直接放行零写入;未策展走 recordUncuratedInstall
 *  (单次 upsert 双账本,失败 fail-closed 由调用方补偿)。 */
function recordReceipt(
  roots: Roots,
  entry: { name: string; type: InstallReceipt["type"]; files: string[]; meta?: InstallMeta; origin?: InstallReceipt["origin"] },
): LedgerOutcome {
  if (entry.meta?.catalogId) return { ok: true }
  const origin = (entry.origin ?? "created") as UncuratedOrigin
  const w = recordUncuratedInstall(roots.alphaDir, {
    kind: entry.type,
    name: entry.name,
    origin,
    environment: tryGetAlphaEnvironment()?.environment ?? "prod",
    scope: roots.identity,
    files: entry.files,
  })
  if (!w.ok) return { ok: false, reason: w.reason }
  const warning = w.warnings.join("; ")
  return { ok: true, ...(warning ? { warning } : {}) }
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/"/g, "'").trim()
}

// Legacy path (escape hatch): the pre-REQ-018 behavior — write straight into the shared XDG config
// dir the engine scans, no bridge, no receipt.
function legacyWrite(kindDir: "skills" | "agent", name: string, write: (dir: string) => string): FsResult {
  const root = opencodeConfigDir()
  const dir = safeResolveUnder(root, kindDir === "skills" ? path.join("skills", name) : "agent")
  if (!dir) return { ok: false, reason: "refused: path escapes config dir" }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = write(dir)
    return { ok: true, files: [file] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "write failed" }
  }
}

/** Write a SKILL.md (frontmatter composed here) into the alpha truth root + bridge + receipt. */
export function writeSkill(
  name: string,
  description: string,
  body: string,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  const content = `---\nname: ${name}\ndescription: ${oneLine(description) || name}\n---\n\n${body || ""}\n`
  if (legacyRootActive()) {
    return legacyWrite("skills", name, (dir) => {
      const file = path.join(dir, "SKILL.md")
      fs.writeFileSync(file, content, "utf8")
      return file
    })
  }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const dir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!dir) return { ok: false, reason: "refused: path escapes alpha root" }
  // Codex review #355:未策展写盘前先过冲突预检 —— 不许先覆盖再被拒(那会毁掉既有 flat 内容)。
  if (!meta?.catalogId) {
    const conflict = checkUncuratedConflict(roots.alphaDir, "skill", name)
    if (!conflict.ok) return conflict
  }
  const mdPath = path.join(dir, "SKILL.md")
  const dirExisted = fs.existsSync(dir)
  const prevMd = dirExisted && fs.existsSync(mdPath) ? fs.readFileSync(mdPath) : null
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(mdPath, content, "utf8")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write skill" }
  }
  // T3(REQ-059):skills 桥退役 —— 真源 ~/.alpha/skills/<name> 就位即可,引擎经 alpha.jsonc 的
  // skills.paths 发现,不再往 .opencode 建桥(不变量:.opencode 内零 alpha 痕迹)。
  const files = [dir]
  const ledger = recordReceipt(roots, { name, type: "skill", files, meta })
  if (!ledger.ok) {
    // #306/#355 fail-closed 补偿:目录原已存在只回退本次覆盖的 SKILL.md(绝不 rm 整目录毁旧内容);
    // 新建目录才整体撤掉。
    try {
      if (dirExisted) {
        if (prevMd !== null) fs.writeFileSync(mdPath, prevMd)
        else fs.rmSync(mdPath, { force: true })
      } else {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* best-effort 补偿 */
    }
    return { ok: false, reason: `install ledger write failed: ${ledger.reason}` }
  }
  return { ok: true, files }
}

/** Write an agent definition (caller composes the markdown) into the alpha truth root + config entry + receipt.
 *  REQ-059 T3b 桥退役:引擎经 alpha.jsonc 的 `agent.<name>` 条目(md 先过 agentMdToEntry 转换,fail-closed)
 *  见到 agent,不再造 `.opencode` 桥(不变量:任何层级零 `.opencode`)。md 文件仍写盘 = 内容真源/人读;
 *  编辑文件不生效(诚实边界:改 agent 走重装/hub)。项目 target 同构(条目写 <proj>/.alpha/alpha.jsonc)。 */
export function writeAgent(name: string, content: string, target?: InstallTarget, meta?: InstallMeta, origin?: InstallReceipt["origin"]): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid agent name" }
  const normalized = content.endsWith("\n") ? content : `${content}\n`
  if (legacyRootActive()) {
    return legacyWrite("agent", name, (dir) => {
      const file = path.join(dir, `${name}.md`)
      fs.writeFileSync(file, normalized, "utf8")
      return file
    })
  }
  const parsed = agentMdToEntry(normalized)
  if (!parsed.ok) return { ok: false, reason: `agent frontmatter not convertible: ${parsed.reason}` }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  // Codex review #355:未策展写盘前冲突预检(不许先覆盖同名 md/条目再被拒)。
  if (!meta?.catalogId) {
    const conflict = checkUncuratedConflict(roots.alphaDir, "agent", name)
    if (!conflict.ok) return conflict
  }
  const dir = safeResolveUnder(roots.alphaDir, "agents")
  if (!dir) return { ok: false, reason: "refused: path escapes alpha root" }
  const file = path.join(dir, `${name}.md`)
  const entryTarget = roots.scope === "project" ? path.join(roots.alphaDir, "alpha.jsonc") : undefined
  // 覆盖场景(更新)的 before-image:失败时按快照复原旧 md/旧条目,不再「撤新 = 毁旧」。
  const prevMd = fs.existsSync(file) ? fs.readFileSync(file) : null
  const prevEntry = readAgentEntry(name, entryTarget)
  const restoreMd = (): void => {
    try {
      if (prevMd !== null) fs.writeFileSync(file, prevMd)
      else fs.unlinkSync(file)
    } catch {
      /* best-effort */
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, normalized, "utf8")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write agent" }
  }
  const persisted = persistAgentEntry(name, parsed.entry, entryTarget)
  if (!persisted.ok) {
    restoreMd() // 条目失败(含配置写锁 busy)按快照回退 md —— 更新场景不丢旧文件
    return { ok: false, reason: `agent config entry failed: ${persisted.reason}` }
  }
  const files = [file]
  const ledger = recordReceipt(roots, { name, type: "agent", files, meta, origin })
  if (!ledger.ok) {
    // #306/#355 fail-closed 补偿:条目按 before-image 复原;条目复原失败则**保留 md**并如实报告
    // (绝不制造「配置可见、md 已删」的半清理态)。
    const entryRestore = prevEntry ? persistAgentEntry(name, prevEntry, entryTarget) : removeAgentEntry(name, entryTarget)
    if (!entryRestore.ok)
      return { ok: false, reason: `install ledger write failed: ${ledger.reason}; compensation failed (${entryRestore.reason}) — md left in place` }
    restoreMd()
    return { ok: false, reason: `install ledger write failed: ${ledger.reason}` }
  }
  return { ok: true, files }
}

// Resolve the app's bundled-resources root the same way windows.ts does: process.resourcesPath when
// packaged, else the in-repo resources/ dir relative to the built main bundle (out/main).
// Exported for the migration provenance check (REQ-044), which byte-compares legacy skill dirs
// against these packaged assets.
export function resourcesRoot(): string {
  // app.isPackaged 的无 electron-import 等价判定(packaged = electron 运行时且非 defaultApp):
  // REQ-063 起 ecosystem-import 复用本模块纯 fs 管线,bun test 加载时无 electron 运行时,
  // 顶层 named import electron 会在 import 期直接炸(Export named 'app' not found)。
  const p = process as { versions?: { electron?: string }; defaultApp?: boolean }
  const packaged = !!p.versions?.electron && !p.defaultApp
  return packaged ? process.resourcesPath : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../resources")
}

// builtinAssetKey is author-controlled (the catalog), but validate it anyway so a bad entry can't
// escape the resources tree. skills/<dir> · agents/<name>.md · plugins/<dir>(REQ-023)。
const SAFE_ASSET_KEY = /^skills\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_AGENT_ASSET_KEY = /^agents\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.md$/
const SAFE_PLUGIN_ASSET_KEY = /^plugins\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Read a bundled builtin skill's SKILL.md for the detail page (REQ-019 T3). Read-only, key
 * validated against the resources/skills tree, size-capped. Fails honestly when the asset isn't
 * bundled in this build (same wording as install).
 */
export function readBuiltinSkill(builtinAssetKey: string): { ok: true; content: string } | { ok: false; reason: string } {
  const isAgent = SAFE_AGENT_ASSET_KEY.test(builtinAssetKey)
  if (!isAgent && !SAFE_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  const file = isAgent
    ? path.join(resourcesRoot(), builtinAssetKey)
    : path.join(resourcesRoot(), builtinAssetKey, "SKILL.md")
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: "技能内容未随此版本打包" }
    if (fs.statSync(file).size > 256 * 1024) return { ok: false, reason: "SKILL.md 过大,略过预览" }
    return { ok: true, content: fs.readFileSync(file, "utf8") }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read skill" }
  }
}

/**
 * Install a builtin (app-bundled) skill: copy resources/<builtinAssetKey>/ into the alpha truth
 * root + bridge + receipt. Fails honestly when the asset isn't bundled in this build, rather than
 * writing a misleading placeholder.
 */
export function installBuiltinSkill(
  builtinAssetKey: string,
  name: string,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  if (!SAFE_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  const srcDir = path.join(resourcesRoot(), builtinAssetKey)
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    return { ok: false, reason: "技能内容未随此版本打包" }
  }
  if (legacyRootActive()) {
    return legacyWrite("skills", name, (dir) => {
      fs.cpSync(srcDir, dir, { recursive: true })
      return dir
    })
  }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const destDir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    // Bundled content is trusted (we authored/vendored it); copy the whole skill dir.
    fs.cpSync(srcDir, destDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to install skill" }
  }
  // T3(REQ-059):skills 桥退役 —— 真源就位,引擎经 skills.paths 发现。
  const files = [destDir]
  recordReceipt(roots, { name, type: "skill", files, meta, origin: "catalog" })
  return { ok: true, files }
}

/** REQ-032:安装**已下载并 sha256 校验过**的远程技能内容(main 内存 → 与 builtin 同管线:
 *  ~/.alpha/skills/<name> + 桥 + 账本;下载与校验在 remote-catalog.downloadRemoteAsset,不在此重复)。 */
export function installRemoteSkill(
  name: string,
  contents: Array<{ path: string; data: Buffer }>,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  const skillMd = contents.find((c) => c.path === "SKILL.md")
  if (!skillMd) return { ok: false, reason: "asset missing SKILL.md" }
  // codex M4:引擎以 frontmatter name 为技能真名 —— 必须与 catalog entry.name 一致,否则装进安全
  // 目录却以另一个名字暴露(可 shadow 既有技能)。不一致拒装(loud)。
  const fm = parseSkillFrontmatter(skillMd.data.toString("utf8"))
  if (!fm.ok) return { ok: false, reason: `SKILL.md frontmatter invalid: ${fm.reason}` }
  if (fm.name !== name) return { ok: false, reason: `frontmatter name "${fm.name}" ≠ catalog entry name "${name}" — refusing to install (name spoofing guard)` }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const destDir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    for (const c of contents) {
      // 清单路径已在下载层拒绝 .. / 绝对路径;这里再过 safeResolve 双保险
      const dst = safeResolveUnder(destDir, ...c.path.split("/"))
      if (!dst) return { ok: false, reason: `refused: asset path escapes skill dir: ${c.path}` }
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, c.data)
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write remote skill" }
  }
  // T3(REQ-059):skills 桥退役 —— 真源就位,引擎经 skills.paths 发现。
  const files = [destDir]
  const receiptLedger = recordReceipt(roots, { name, type: "skill", files, meta, origin: "catalog" })
  // codex L2:账本写失败时文件/桥已落盘 —— 不谎报失败(技能实际可用),但 loud 记录(卸载/更新将失真)。
  const receiptWarn = receiptLedger.ok ? receiptLedger.warning : receiptLedger.reason
  if (receiptWarn) console.error(`[ext-fs-installer] remote skill "${name}" installed but receipt failed: ${receiptWarn}`)
  return { ok: true, files }
}

// Resolve roots WITHOUT scaffolding — for uninstall (never create dirs we're about to delete from).
function resolveRootsReadonly(target: InstallTarget | undefined): Roots | { error: string } {
  const t = target ?? { scope: "global" as const }
  if (t.scope === "global") return { alphaDir: alphaGlobalRoot(), opencodeDir: opencodeHomeDir(), scope: "global", identity: { kind: "global" } }
  if (typeof t.projectDir !== "string") return { error: "invalid project directory" }
  const root = alphaRoot(t.projectDir)
  if (!root) return { error: `invalid project directory: ${t.projectDir}` }
  const identity = projectScopeIdentity(t.projectDir)
  if (!identity.ok) return { error: `fail closed: ${identity.reason}` }
  return { alphaDir: root, opencodeDir: path.join(t.projectDir, ".opencode"), scope: "project", identity: identity.scope }
}

/**
 * Uninstall a skill/agent: remove its truth dir/file under .alpha, unbridge its .opencode link, and
 * drop the receipt. Legacy installs (ALPHA_LEGACY_INSTALL_ROOT era, no bridge/receipt) are removed
 * from the old XDG root by name. Missing target = already-gone success (idempotent).
 */
export function removeFsInstall(type: "skill" | "agent", name: string, target?: InstallTarget): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
  const removed: string[] = []
  // legacy XDG location (best-effort, pre-migration installs)
  const legacyRoot = opencodeConfigDir()
  const legacyTarget = type === "skill" ? path.join(legacyRoot, "skills", name) : path.join(legacyRoot, "agent", `${name}.md`)
  try {
    if (fs.existsSync(legacyTarget)) {
      fs.rmSync(legacyTarget, { recursive: true, force: true })
      removed.push(legacyTarget)
    }
  } catch {
    /* best-effort */
  }
  const roots = resolveRootsReadonly(target)
  if ("error" in roots) return removed.length ? { ok: true, files: removed } : { ok: false, reason: roots.error }
  const kind = type === "skill" ? "skills" : "agents"
  const truth = type === "skill" ? path.join(roots.alphaDir, "skills", name) : path.join(roots.alphaDir, "agents", `${name}.md`)
  // REQ-059 T3b:agent 条目净除(alpha.jsonc 的 agent.<name>;存量桥装的 agent 无条目 → no-op 幂等)。
  // Codex review #351:配置删除(可因配置写锁 busy 失败)必须在删内容文件**之前**——否则 busy 会把
  // 操作报失败却已不可逆地拆掉真源文件(半拆态)。
  if (type === "agent") {
    const entryTarget = roots.scope === "project" ? path.join(roots.alphaDir, "alpha.jsonc") : undefined
    const r = removeAgentEntry(name, entryTarget)
    if (!r.ok) return { ok: false, reason: `agent config entry removal failed: ${r.reason}` }
  }
  try {
    if (fs.existsSync(truth)) {
      fs.rmSync(truth, { recursive: true, force: true })
      removed.push(truth)
    }
    unbridgeItem(roots.alphaDir, roots.opencodeDir, kind, name).removed.forEach((r) => removed.push(r))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to remove" }
  }
  removeReceipt(roots.alphaDir, type, name)
  return { ok: true, files: removed }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REQ-019 T6:导入(folder / git)。外来内容纪律(PR #73 教训):只解析 frontmatter、只复制文件,
// 绝不执行导入内容;git 先浅克隆到临时目录、校验通过才入 .alpha;symlink 一律不跟随不复制。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const IMPORT_MAX_TOTAL = 10 * 1024 * 1024 // 整个技能目录 10MB 帽
const IMPORT_MAX_ENTRIES = 500
const SKILL_MD_MAX = 256 * 1024


// 递归收集可复制文件(拒 symlink、跳 .git/node_modules、计数与体积帽)。返回相对路径列表。
function collectImportFiles(srcDir: string): { ok: true; files: string[] } | { ok: false; reason: string } {
  const files: string[] = []
  let total = 0
  const walk = (rel: string): string | null => {
    const abs = path.join(srcDir, rel)
    const entries = fs.readdirSync(abs, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue
      const childRel = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isSymbolicLink()) continue // 不跟随、不复制(防逃逸/防内容偷换)
      if (entry.isDirectory()) {
        const err = walk(childRel)
        if (err) return err
      } else if (entry.isFile()) {
        const size = fs.statSync(path.join(srcDir, childRel)).size
        total += size
        files.push(childRel)
        if (files.length > IMPORT_MAX_ENTRIES) return `文件数超过 ${IMPORT_MAX_ENTRIES} 上限`
        if (total > IMPORT_MAX_TOTAL) return "目录超过 10MB 上限"
      }
    }
    return null
  }
  try {
    const err = walk("")
    if (err) return { ok: false, reason: err }
    return { ok: true, files }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read folder" }
  }
}

/** 导入本地技能文件夹:校验 SKILL.md frontmatter → 逐文件复制入 .alpha + receipt。
 *  origin 默认 imported;REQ-063 外部生态转换导入传 imported-claude / imported-agents(hub 可溯源)。 */
export function importSkillFolder(
  srcDir: string,
  target?: InstallTarget,
  origin: InstallReceipt["origin"] = "imported",
): FsResult & { name?: string } {
  if (typeof srcDir !== "string" || !path.isAbsolute(srcDir)) return { ok: false, reason: "invalid folder" }
  let real: string
  try {
    real = fs.realpathSync(srcDir)
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: "不是文件夹" }
  } catch {
    return { ok: false, reason: "文件夹不存在" }
  }
  const skillMd = path.join(real, "SKILL.md")
  let text: string
  try {
    if (fs.statSync(skillMd).size > SKILL_MD_MAX) return { ok: false, reason: "SKILL.md 过大(>256KB)" }
    text = fs.readFileSync(skillMd, "utf8")
  } catch {
    return { ok: false, reason: "文件夹内没有 SKILL.md" }
  }
  const fm = parseSkillFrontmatter(text)
  if (!fm.ok) return fm
  const name = fm.name
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const destDir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  if (fs.existsSync(destDir)) return { ok: false, reason: `同名技能已存在(${name}),请先卸载再导入` }
  // Codex review #355:复制前过账本冲突预检(catalog 同键/generation store)——省掉复制后再拒的补偿。
  const conflict = checkUncuratedConflict(roots.alphaDir, "skill", name)
  if (!conflict.ok) return conflict
  const listed = collectImportFiles(real)
  if (!listed.ok) return listed
  try {
    for (const rel of listed.files) {
      const destFile = path.join(destDir, rel)
      fs.mkdirSync(path.dirname(destFile), { recursive: true })
      fs.copyFileSync(path.join(real, rel), destFile)
    }
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true }) // 半成品不留
    return { ok: false, reason: error instanceof Error ? error.message : "复制失败" }
  }
  // T3(REQ-059):skills 桥退役 —— 真源就位,引擎经 skills.paths 发现。
  const files = [destDir]
  const ledger = recordReceipt(roots, { name, type: "skill", files, origin })
  if (!ledger.ok) {
    fs.rmSync(destDir, { recursive: true, force: true }) // #306 fail-closed:账本没进,导入不算成功
    return { ok: false, reason: `install ledger write failed: ${ledger.reason}` }
  }
  return { ok: true, files, name }
}

/** 导入 Git 仓库技能:https-only 浅克隆到临时目录 → 定位 SKILL.md(根或唯一子目录)→ 走文件夹导入。 */
export async function importSkillGit(url: string, target?: InstallTarget): Promise<FsResult & { name?: string }> {
  if (!validGitUrl(url)) return { ok: false, reason: "仅支持 https Git 地址" }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-import-git-"))
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["clone", "--depth", "1", "--single-branch", "--no-tags", url, tmp],
        { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (err, _stdout, stderr) => (err ? reject(new Error(oneLine(String(stderr || err.message)).slice(0, 200))) : resolve()),
      )
    })
    let src = tmp
    if (!fs.existsSync(path.join(src, "SKILL.md"))) {
      const dirs = fs
        .readdirSync(tmp, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== ".git")
        .map((e) => e.name)
      const candidate = dirs.length === 1 ? path.join(tmp, dirs[0]) : null
      if (!candidate || !fs.existsSync(path.join(candidate, "SKILL.md")))
        return { ok: false, reason: "仓库内未找到 SKILL.md(根目录或唯一子目录)" }
      src = candidate
    }
    return importSkillFolder(src, target)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "克隆失败" }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REQ-023 T2:vendored 供给链 —— 官方 agent md 资产安装 + vendored 插件零网络安装。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** 安装随 app 打包的官方 agent(md 资产):读文件(体积帽)→ 走 writeAgent 同管线(桥+账本)。 */
/** #354(Codex 裁决必改 3 替代路径):catalog agent 无更新链(updateEntry 不支持 agent),
 *  写前存在性检查 —— 既有(有账或无账文件)一律拒绝,拒绝静默覆盖/认领;由此 catalog agent
 *  安装可证明 fresh,提交面失败补偿 removeFsInstall 不会毁旧物。解析失败按在场处理(fail-closed)。 */
export function agentInstallPresent(name: string, target?: InstallTarget): boolean {
  if (!SAFE_NAME.test(name)) return true
  const roots = resolveRoots(target)
  if ("error" in roots) return true
  const dir = safeResolveUnder(roots.alphaDir, "agents")
  if (!dir) return true
  if (fs.existsSync(path.join(dir, `${name}.md`))) return true
  // review #379 Blocker:md 缺席不代表不在场 —— 手工 `agent.<name>` 配置(无 md、无账)同样是
  // 既有安装事实,writeAgent 会覆盖它、失败补偿 removeFsInstall 会删掉它 = 用户数据丢失。
  // 配置项检查走 strict(不可读/语法损坏按在场处理,fail-closed);target 派生与 writeAgent 同源。
  const entryTarget = roots.scope === "project" ? path.join(roots.alphaDir, "alpha.jsonc") : undefined
  const entry = readAgentEntryStrict(name, entryTarget)
  if (!entry.ok) return true
  return entry.present
}

export function installBuiltinAgent(
  builtinAssetKey: string,
  name: string,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_AGENT_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid agent name" }
  const file = path.join(resourcesRoot(), builtinAssetKey)
  let content: string
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: "Agent 内容未随此版本打包" }
    if (fs.statSync(file).size > 256 * 1024) return { ok: false, reason: "agent md 过大" }
    content = fs.readFileSync(file, "utf8")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read agent asset" }
  }
  return writeAgent(name, content, target, meta)
}

/**
 * 安装远程 agent(REQ-046:补齐零发版最后一类)。资产约定 = 单个 .md 文件(引擎以文件名为 agent 名,
 * 无 skill 那样的 frontmatter name 通道 → 无 spoof 面);下载层已做 sha256 钉死 + 路径消毒,
 * 这里再收:单文件 / .md 后缀 / 256KB 帽(与 installBuiltinAgent 同帽)。写盘/桥/账本走 writeAgent 同管线。
 */
export function installRemoteAgent(
  name: string,
  contents: Array<{ path: string; data: Buffer }>,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid agent name" }
  if (contents.length !== 1) return { ok: false, reason: `agent remote asset must be exactly one .md file (got ${contents.length})` }
  const file = contents[0]!
  if (!file.path.endsWith(".md") || file.path.includes("/")) return { ok: false, reason: `agent remote asset must be a top-level .md file (got ${file.path})` }
  if (file.data.length > 256 * 1024) return { ok: false, reason: "agent md 过大" }
  return writeAgent(name, file.data.toString("utf8"), target, meta, "catalog")
}

/**
 * 安装 vendored 插件(零网络):复制 resources/plugins/<key> → ~/.alpha/plugins/<name>/ →
 * plugin[] 写 plugin.js 绝对路径(persistPluginPath 校验路径必须在 ~/.alpha/plugins 树内)。
 */
/** #352(Codex 裁决必改 5,versioned 路线):vendored 替换的**纯 staging** —— 新内容落
 *  不可变 versioned 目录 `plugins/<name>@<hex>`(绝不覆盖既有 `<name>` 目录),零 config/账本
 *  副作用;config 路径与 receipt 由替换事务原子切换,旧目录事务成功后 GC。staging 半成品由
 *  调用方失败清理(残留无 config 引用,无害)。 */
export function stageVendoredPluginVersioned(
  vendoredAssetKey: string,
  name: string,
): { ok: true; dir: string; jsPath: string } | { ok: false; reason: string } {
  if (!SAFE_PLUGIN_ASSET_KEY.test(vendoredAssetKey)) return { ok: false, reason: "invalid asset key" }
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid plugin name" }
  const srcDir = path.join(resourcesRoot(), vendoredAssetKey)
  if (!fs.existsSync(path.join(srcDir, "plugin.js"))) return { ok: false, reason: "插件内容未随此版本打包" }
  const versioned = `${name}@${crypto.randomBytes(4).toString("hex")}`
  const destDir = safeResolveUnder(alphaGlobalRoot(), "plugins", versioned)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.cpSync(srcDir, destDir, { recursive: true })
  } catch (error) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true })
    } catch {
      /* 半成品残留无 config 引用 */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to stage plugin" }
  }
  return { ok: true, dir: destDir, jsPath: path.join(destDir, "plugin.js") }
}

export function installVendoredPlugin(
  vendoredAssetKey: string,
  name: string,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_PLUGIN_ASSET_KEY.test(vendoredAssetKey)) return { ok: false, reason: "invalid asset key" }
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid plugin name" }
  const srcDir = path.join(resourcesRoot(), vendoredAssetKey)
  if (!fs.existsSync(path.join(srcDir, "plugin.js"))) return { ok: false, reason: "插件内容未随此版本打包" }
  const destDir = safeResolveUnder(alphaGlobalRoot(), "plugins", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.cpSync(srcDir, destDir, { recursive: true }) // vendored 内容可信(我方打包),整目录复制
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to copy plugin" }
  }
  const jsPath = path.join(destDir, "plugin.js")
  const persisted = persistPluginPath(name, jsPath, [destDir], meta)
  if (!persisted.ok) {
    fs.rmSync(destDir, { recursive: true, force: true }) // 半成品不留
    return persisted
  }
  return { ok: true, files: [destDir] }
}
