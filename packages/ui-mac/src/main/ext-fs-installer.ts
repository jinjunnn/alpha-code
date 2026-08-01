// Extension Hub file installer (main process) — REQ-018 T2 rework. User-authored / catalog skills
// and agents now land in the ALPHA truth root (`<current-environment-root>/{skills,agents}` for global scope,
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
import { alphaGlobalRoot } from "./alpha-installs"
import { tryGetAlphaEnvironment } from "./alpha-environment"
import { projectScopeIdentity, type ScopeIdentity } from "./ext-receipt-v2"
import { checkUncuratedConflict, recordUncuratedInstall, type UncuratedOrigin } from "./ext-uncurated-record"
import { alphaRoot, ensureAlphaScaffold } from "./alpha-workdir"
import type { InstallMeta, InstallReceipt, InstallTarget } from "../preload/types"
import { parseSkillFrontmatter, validGitUrl } from "./ext-import-validate"
import { collectSkillPayloadFromDir } from "./ext-skill-generations"
import { isExtensionName } from "../shared/extension-name"

export type FsResult = { ok: true; files?: string[] } | { ok: false; reason: string }

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

type LedgerOutcome = { ok: true; warning?: string; projectionLag?: string } | { ok: false; reason: string }

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
  // #336 r1:projectionLag(账本 durable、skills 允许集发布失败)独立透传 —— flat import 链
  // 不得在此丢弃,renderer 端到端呈现「重启后生效」。
  return { ok: true, ...(warning ? { warning } : {}), ...(w.projectionLag ? { projectionLag: w.projectionLag } : {}) }
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
  if (!isExtensionName(name)) return { ok: false, reason: "invalid skill name" }
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
  // T3(REQ-059):skills 桥退役 —— 当前环境 skills/<name> 就位即可,引擎经 alpha.jsonc 的
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
  if (!isExtensionName(name)) return { ok: false, reason: "invalid agent name" }
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
function isExtensionAssetKey(
  value: string,
  directory: "skills" | "agents" | "plugins",
  extension = "",
): boolean {
  const prefix = `${directory}/`
  if (!value.startsWith(prefix) || !value.endsWith(extension)) return false
  return isExtensionName(value.slice(prefix.length, extension ? -extension.length : undefined))
}

/**
 * Read a bundled builtin skill's SKILL.md for the detail page (REQ-019 T3). Read-only, key
 * validated against the resources/skills tree, size-capped. Fails honestly when the asset isn't
 * bundled in this build (same wording as install).
 */
export function readBuiltinSkill(builtinAssetKey: string): { ok: true; content: string } | { ok: false; reason: string } {
  const isAgent = isExtensionAssetKey(builtinAssetKey, "agents", ".md")
  if (!isAgent && !isExtensionAssetKey(builtinAssetKey, "skills"))
    return { ok: false, reason: "invalid asset key" }
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
  if (!isExtensionName(name)) return { ok: false, reason: "invalid skill name" }
  if (!isExtensionAssetKey(builtinAssetKey, "skills")) return { ok: false, reason: "invalid asset key" }
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
 *  当前环境 skills/<name> + 账本;下载与校验在 remote-catalog.downloadRemoteAsset,不在此重复)。 */
export function installRemoteSkill(
  name: string,
  contents: Array<{ path: string; data: Buffer }>,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!isExtensionName(name)) return { ok: false, reason: "invalid skill name" }
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
 * Uninstall a skill/agent: remove its truth dir/file under .alpha and unbridge its .opencode link.
 * REQ-128 `#706`:**不动账本** —— 去账只归外层单点提交。Legacy installs
 * (ALPHA_LEGACY_INSTALL_ROOT era, no bridge/receipt) are removed from the old XDG root by name.
 * Missing target = already-gone success (idempotent).
 */
/**
 * `#698`(review R2 Blocker 1):**只删内容文件,绝不碰配置**。
 *
 * update 路径把离场 child 的 `agent.<name>` 配置删除交给了事务自己的 config item(在引擎的锁与
 * before-image 回滚体系内)。剩下的内容文件必须在事务**返回之后**清理,而那一步绝不能再去取
 * 配置写锁 —— `withConfigWriteLock` 与事务共用同一把非重入的 bundle 锁。走这个入口,重入在
 * **构造上**不可能发生,而不是靠调用方记得。
 */
export function removeFsInstallFilesOnly(type: "skill" | "agent", name: string, target?: InstallTarget): FsResult {
  return removeFsInstallImpl(type, name, target, true)
}

export function removeFsInstall(type: "skill" | "agent", name: string, target?: InstallTarget): FsResult {
  return removeFsInstallImpl(type, name, target, false)
}

function removeFsInstallImpl(type: "skill" | "agent", name: string, target: InstallTarget | undefined, filesOnly: boolean): FsResult {
  if (!isExtensionName(name)) return { ok: false, reason: "invalid name" }
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
  // filesOnly:配置那一半已由调用方以事务 config item 的形式处理(见 removeFsInstallFilesOnly)。
  if (type === "agent" && !filesOnly) {
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
  // REQ-128 `#706`:这里**不再**碰账本。原先内层 `removeReceipt` 有两个真问题:
  //   ① 它走的是 v1 物理写器,会把账本重写成 v:2 —— V3 的 packageGraphs/claims 静默蒸发;
  //   ② 它在删完实物之后跑、返回值被忽略 —— 账本拒写时用户看到「卸载失败」而东西已经没了。
  // 账本只由外层单点提交(uninstallByKey / 恢复期的 commitUninstall),claim-aware 判决则在
  // 删任何实物之前就做完(planDirectUninstall)。
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

/** #390:未策展技能导入 byte-exact 单文件读 —— realpath 圈禁(父目录 symlink 逃逸)+ O_NOFOLLOW
 *  开(末段 symlink 换内容)+ fstat 前置帽 + 定长读 + 增长探测(帽/身份都以实际字节为准,不信 walk 期
 *  stat 快照;review r1 Major 3/4)。data.length 即最终帽依据,调用方据此累计真实总量。 */
function readImportFileBounded(
  abs: string,
  realBase: string,
  capBytes: number,
): { ok: true; data: Buffer } | { ok: false; reason: string; oversize?: boolean } {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  // O_NONBLOCK(review r3 Major 2):竞态把常规文件换成 FIFO 时,同步 O_RDONLY 会阻塞等 writer,
  // 冻死 Electron main —— 非阻塞打开后立即 fstat + isFile 拒非常规文件。
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0
  const errnoCode = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined
  let fd: number
  try {
    // review r5:开**原始 abs**(非 realpath 后的 rp)—— 否则 O_NOFOLLOW 护的是已解析路径、对末段
    // symlink 完全失效(realpath 已跟过)。开 abs 使 O_NOFOLLOW 真正封末段 symlink(swap 成 symlink → ELOOP 拒)。
    fd = fs.openSync(abs, fs.constants.O_RDONLY | noFollow | nonBlock)
  } catch (error) {
    if (errnoCode(error) === "ELOOP") return { ok: false, reason: "import: 是 symlink — 拒(须常规文件)" }
    return { ok: false, reason: "import: 无法安全打开(symlink / 特殊文件)— 拒" }
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    if (!st.isFile()) return { ok: false, reason: "import: 不是常规文件 — 拒" }
    // 圈禁缩窗纵深(review r2/r3/r5):末段 symlink 已由「开 abs + O_NOFOLLOW」封死;父目录 symlink 逃逸
    // 由 open 后 realpath 复核收尾 —— ① realpath(abs) 落 realBase 外(稳定换向)→ 拒;② 复核 fd 与「规范
    // 路径当前指向的文件」同 dev/ino(换回原链 = fd 指树外而规范路径落树内,dev/ino 不等 → 拒)。Node 无
    // openat,dev/ino 相等不等于圈禁封死;父目录多次精确换向属固有残余(能在源目录内换目录链者等价于
    // 导入内容作者;与 collectBuiltinAgentPayload 同纵深)。
    let rp: string
    let pathSt: fs.BigIntStats
    try {
      rp = fs.realpathSync(abs)
      pathSt = fs.statSync(rp, { bigint: true })
    } catch (error) {
      const code = errnoCode(error)
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
        return { ok: false, reason: "import: 路径读取期间改变身份(symlink race)— 拒" }
      return { ok: false, reason: error instanceof Error ? error.message : "import: 读取失败" }
    }
    if (rp !== realBase && !rp.startsWith(realBase + path.sep))
      return { ok: false, reason: "import: 路径逃逸源目录 — 拒" }
    if (st.dev !== pathSt.dev || st.ino !== pathSt.ino)
      return { ok: false, reason: "import: 路径读取期间改变身份(symlink race)— 拒" }
    if (st.size > BigInt(capBytes)) return { ok: false, reason: "import: 超过大小上限", oversize: true }
    const size = Number(st.size)
    const data = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = fs.readSync(fd, data, off, size - off, off)
      if (n === 0) break
      off += n
    }
    if (off !== size) return { ok: false, reason: "import: 读取长度不符(文件在变)— 拒" }
    // fstat 后 inode 仍可增长;读毕探 1 字节,有余量 = 文件在变,拒(定长读会绕过已执行的帽)。
    const probe = Buffer.alloc(1)
    if (fs.readSync(fd, probe, 0, 1, size) !== 0) return { ok: false, reason: "import: 文件读取期间增长 — 拒" }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "import: 读取失败" }
  } finally {
    fs.closeSync(fd)
  }
}

/** #390:未策展技能导入的 byte-exact 载荷采集 —— 集中 import 校验(realpath / SKILL.md 帽 +
 *  frontmatter → name / 体积·计数帽 / 跳 .git·node_modules / 拒 symlink),返回 POSIX 相对路径
 *  载荷,供 planner 提升进验证共享 CAS 走 generation 事务(取代 flat copy)。只读零副作用。
 *  帽与 symlink 身份全部以 fd 绑定的实际字节为准(见 readImportFileBounded)。 */
export function collectImportSkillPayload(
  srcDir: string,
): { ok: true; name: string; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string } {
  if (typeof srcDir !== "string" || !path.isAbsolute(srcDir)) return { ok: false, reason: "invalid folder" }
  let real: string
  try {
    real = fs.realpathSync(srcDir)
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: "不是文件夹" }
  } catch {
    return { ok: false, reason: "文件夹不存在" }
  }
  // 根 SKILL.md **先于目录遍历**读一次(review r2 Major 2 单读 + r3/r4 Minor 1:无效 frontmatter 早拒、
  // 越界报 SKILL.md 过大而非误报目录帽 —— collectImportFiles 的粗总量检查含 SKILL.md,若放它后面会先
  // 报「目录超过 10MB」)。lstat 门:根 SKILL.md 必须是非 symlink 常规文件(symlink/特殊 = 视作无
  // SKILL.md,与 walk 跳 symlink dirent 的语义一致)。
  const skillMdAbs = path.join(real, "SKILL.md")
  let smdLst: fs.Stats
  try {
    smdLst = fs.lstatSync(skillMdAbs)
  } catch {
    return { ok: false, reason: "文件夹内没有 SKILL.md" }
  }
  if (!smdLst.isFile()) return { ok: false, reason: "文件夹内没有 SKILL.md" }
  const smd = readImportFileBounded(skillMdAbs, real, Math.min(SKILL_MD_MAX, IMPORT_MAX_TOTAL))
  if (!smd.ok) return { ok: false, reason: smd.oversize ? "SKILL.md 过大(>256KB)" : smd.reason }
  const fm = parseSkillFrontmatter(smd.data.toString("utf8"))
  if (!fm.ok) return fm
  const listed = collectImportFiles(real) // walk:跳 .git/node_modules、拒 symlink dirent、粗计数帽
  if (!listed.ok) return listed
  const files: Array<{ path: string; data: Buffer }> = [{ path: "SKILL.md", data: smd.data }]
  let total = smd.data.length // 权威总量帽 = 实际读入字节(非 walk 期 stat 快照)
  for (const rel of listed.files) {
    if (rel === "SKILL.md") continue // 已读
    const r = readImportFileBounded(path.join(real, rel), real, IMPORT_MAX_TOTAL - total)
    if (!r.ok) return { ok: false, reason: r.oversize ? "目录超过 10MB 上限" : r.reason }
    total += r.data.length
    files.push({ path: rel.split(path.sep).join("/"), data: r.data })
  }
  return { ok: true, name: fm.name, files }
}

/** #390:git 技能仓浅克隆到临时目录并定位 SKILL.md 源目录(网络/SSRF 隔离与 importSkillGit 同源)。
 *  返回本地源目录 + 清理句柄,供 planner 走 CAS 事务导入;调用方 finally 必须 cleanup()。 */
export async function cloneSkillGitToTmp(
  url: string,
): Promise<{ ok: true; srcDir: string; cleanup: () => void } | { ok: false; reason: string }> {
  if (!validGitUrl(url)) return { ok: false, reason: "仅支持 https Git 地址" }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-import-git-"))
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  try {
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull }
    delete gitEnv.GIT_CONFIG_PARAMETERS
    const count = Number.parseInt(gitEnv.GIT_CONFIG_COUNT ?? "", 10)
    if (Number.isFinite(count)) for (let i = 0; i < count; i++) {
      delete gitEnv[`GIT_CONFIG_KEY_${i}`]
      delete gitEnv[`GIT_CONFIG_VALUE_${i}`]
    }
    delete gitEnv.GIT_CONFIG_COUNT
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["-c", "http.followRedirects=false", "clone", "--depth", "1", "--single-branch", "--no-tags", url, tmp],
        { timeout: 60_000, env: gitEnv },
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
      if (!candidate || !fs.existsSync(path.join(candidate, "SKILL.md"))) {
        cleanup()
        return { ok: false, reason: "仓库内未找到 SKILL.md(根目录或唯一子目录)" }
      }
      src = candidate
    }
    return { ok: true, srcDir: src, cleanup }
  } catch (error) {
    cleanup()
    return { ok: false, reason: error instanceof Error ? error.message : "克隆失败" }
  }
}

/** 导入本地技能文件夹:校验 SKILL.md frontmatter → 逐文件复制入 .alpha + receipt。
 *  origin 默认 imported;REQ-063 外部生态转换导入传 imported-claude / imported-agents(hub 可溯源)。
 *  #390:global 未策展导入的生产路径已改走 planner 的 CAS 事务(installUncuratedSkillImport);
 *  本 flat 实现保留给 project scope 的 sanctioned 路径(ADR-030)与既有测试。 */
export function importSkillFolder(
  srcDir: string,
  target?: InstallTarget,
  origin: InstallReceipt["origin"] = "imported",
): FsResult & { name?: string; warning?: string; projectionLag?: string } {
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
  // #336 r1:warning/projectionLag 随成功结果透传(此前在此丢弃 = import 用户可见入口失联)。
  return {
    ok: true,
    files,
    name,
    ...(ledger.warning ? { warning: ledger.warning } : {}),
    ...(ledger.projectionLag ? { projectionLag: ledger.projectionLag } : {}),
  }
}

/** 导入 Git 仓库技能:https-only 浅克隆到临时目录 → 定位 SKILL.md(根或唯一子目录)→ 走文件夹导入。 */
export async function importSkillGit(url: string, target?: InstallTarget): Promise<FsResult & { name?: string; warning?: string; projectionLag?: string }> {
  if (!validGitUrl(url)) return { ok: false, reason: "仅支持 https Git 地址" }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-import-git-"))
  try {
    // #335 review r1 Blocker:allowlist 校验的 URL 若被 git 配置改写就形同虚设 ——
    // 全局/系统 gitconfig 的 `url.<base>.insteadOf` 能把 github.com URL 重写到内网,
    // `http.<url>.*` 能改重定向行为。隔离全部配置源:GLOBAL/SYSTEM config 指向 devNull,
    // 清 env 注入的配置(GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT + KEY/VALUE 对)——
    // 公网 forge 的匿名 https clone 不需要任何用户配置。
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull }
    delete gitEnv.GIT_CONFIG_PARAMETERS
    const count = Number.parseInt(gitEnv.GIT_CONFIG_COUNT ?? "", 10)
    if (Number.isFinite(count)) for (let i = 0; i < count; i++) {
      delete gitEnv[`GIT_CONFIG_KEY_${i}`]
      delete gitEnv[`GIT_CONFIG_VALUE_${i}`]
    }
    delete gitEnv.GIT_CONFIG_COUNT
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        // http.followRedirects=false —— allowlist 只校验原 URL,禁重定向防 clone 被可信 forge 的
        // 开放重定向/被攻陷响应导向私网或禁端口(SSRF 纵深)。
        ["-c", "http.followRedirects=false", "clone", "--depth", "1", "--single-branch", "--no-tags", url, tmp],
        { timeout: 60_000, env: gitEnv },
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

/** #354(Codex 裁决必改 3 替代路径):catalog agent 无更新链(updateEntry 不支持 agent),
 *  写前存在性检查 —— 既有(有账或无账文件)一律拒绝,拒绝静默覆盖/认领。#361 起 catalog agent
 *  走事务载体,本函数只剩锁外快速拒用途(锁内权威门 = planner 的 agentFreshGate)。
 *  解析失败按在场处理(fail-closed)。 */
export function agentInstallPresent(name: string, target?: InstallTarget): boolean {
  if (!isExtensionName(name)) return true
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

/** #361:收集随包官方 agent md 为原始载荷(catalog agent 事务安装的 CAS 摄取源)。只读零副作用;
 *  返回原始 Buffer 保持 byte-exact(installAgentFromCas 的 CAS digest 语义,不做字符串归一)。
 *  SAFE key 校验 + **内容身份交叉**(key 必须恰为 agents/<name>.md,review r1 Major 1:已验签
 *  但配错的 entry 不得把别的资产按本 agent 身份装入)、**realpath 圈禁 → O_NOFOLLOW 开已解析
 *  路径 → fd/path dev+ino 身份绑定**(r1 Minor 4 + r2 + r3:词法正则不防 symlink,O_NOFOLLOW
 *  只管末段,父目录链接/win32 退化面/相邻 syscall 换链竞态由三重检查逐层缩窗)、256KB 帽
 *  fd 上 fstat 判 + 读后 Buffer 复核(r1 Minor 5:封 stat/read 窗口增长)。 */
export function collectBuiltinAgentPayload(
  builtinAssetKey: string,
  name: string,
): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string } {
  if (!isExtensionAssetKey(builtinAssetKey, "agents", ".md")) return { ok: false, reason: "invalid asset key" }
  if (!isExtensionName(name)) return { ok: false, reason: "invalid agent name" }
  if (builtinAssetKey !== `agents/${name}.md`)
    return { ok: false, reason: `asset key "${builtinAssetKey}" ≠ "agents/${name}.md" — refusing (content identity drift)` }
  const file = path.join(resourcesRoot(), builtinAssetKey)
  const errnoOf = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined
  // realpath 圈禁先行(review #384 r2:末段 O_NOFOLLOW 不防父目录 symlink,win32 无该位时
  // 完全退化)—— 解析后的真实路径必须恰为 <realpath(resources)>/agents/<name>.md,任何组件
  // 是链接都会导致不等式,拒绝;随后 open 的是已解析路径。
  let realFile: string
  try {
    realFile = fs.realpathSync(file)
    const expected = path.join(fs.realpathSync(resourcesRoot()), "agents", `${name}.md`)
    if (realFile !== expected)
      return { ok: false, reason: "agent asset escapes the resources tree (symlinked path) — refusing" }
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { ok: false, reason: "Agent 内容未随此版本打包" }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read agent asset" }
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  let fd: number
  try {
    fd = fs.openSync(realFile, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    const code = errnoOf(error)
    if (code === "ENOENT") return { ok: false, reason: "Agent 内容未随此版本打包" }
    if (code === "ELOOP") return { ok: false, reason: "agent asset is a symlink — refusing (must be a regular bundled file)" }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read agent asset" }
  }
  try {
    // fd/path 身份绑定(review #384 r3):realpath 校验与 open 是相邻 syscall,父目录在其间
    // 被换链再换回时 fd 可能已指向树外文件 —— 复核「验证过的路径当前指向的文件」与 fd 同
    // dev/ino。Node 无 openat 原语,多重检查缩窗属纵深(能写 resources 树者本就等价于资产
    // 作者):要骗过 O_NOFOLLOW + realpath 等值 + 身份绑定,需在多个相邻 syscall 间各完成
    // 一次精确换向。
    const st = fs.fstatSync(fd, { bigint: true })
    let pathSt: fs.BigIntStats
    try {
      pathSt = fs.statSync(realFile, { bigint: true })
    } catch (error) {
      // 只把路径身份变化类 errno 归为换链竞态(r4:EACCES/EIO 等真实故障保留原始原因,不误诊)。
      const code = errnoOf(error)
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
        return { ok: false, reason: "agent asset changed identity during read (symlink race) — refusing" }
      return { ok: false, reason: error instanceof Error ? error.message : "failed to read agent asset" }
    }
    if (st.dev !== pathSt.dev || st.ino !== pathSt.ino)
      return { ok: false, reason: "agent asset changed identity during read (symlink race) — refusing" }
    if (!st.isFile()) return { ok: false, reason: "agent asset is not a regular file — refusing" }
    if (st.size > 256n * 1024n) return { ok: false, reason: "agent md 过大" }
    const data = fs.readFileSync(fd)
    if (data.length > 256 * 1024) return { ok: false, reason: "agent md 过大" }
    return { ok: true, files: [{ path: `${name}.md`, data }] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read agent asset" }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 安装 vendored 插件(零网络):复制 resources/plugins/<key> → 当前环境 plugins/<name>/ →
 * plugin[] 写 plugin.js 绝对路径(persistPluginPath 校验路径必须在当前环境 plugins 树内)。
 */
/** #352(Codex 裁决必改 5,versioned 路线):vendored 替换的**纯 staging** —— 新内容落
 *  不可变 versioned 目录 `plugins/<name>@<hex>`(绝不覆盖既有 `<name>` 目录),零 config/账本
 *  副作用;config 路径与 receipt 由替换事务原子切换,旧目录事务成功后 GC。staging 半成品由
 *  调用方失败清理(残留无 config 引用,无害)。
 *  #378 r16(Major):staging 源走与 fresh 同一硬化收集合同(collectVendoredPluginPayload:
 *  身份绑定、realpath 圈禁、常规文件、16/64MB 帽)—— cpSync 原样复制会把 fresh 被拒的
 *  symlink/非常规条目/超帽载荷在 update/repair 通道原样激活;落盘逐文件写内存态载荷,
 *  目标路径再圈禁一次。 */
export function stageVendoredPluginVersioned(
  vendoredAssetKey: string,
  name: string,
  // r17(Major):调用方已收集的载荷直传 —— receipt digest 与 staging 字节必须同一次收集
  // (两次独立收集之间源变化会提交「载荷 B + digest A」,内容身份断链)。缺省自收集。
  precollected?: Array<{ path: string; data: Buffer }>,
): { ok: true; dir: string; jsPath: string } | { ok: false; reason: string } {
  if (!isExtensionAssetKey(vendoredAssetKey, "plugins")) return { ok: false, reason: "invalid asset key" }
  if (!isExtensionName(name)) return { ok: false, reason: "invalid plugin name" }
  let files: Array<{ path: string; data: Buffer }>
  if (precollected) files = precollected
  else {
    const collected = collectVendoredPluginPayload(vendoredAssetKey, name)
    if (!collected.ok) return collected
    files = collected.files
  }
  // r17(Major):versioned 目录**排他认领** —— recursive mkdir 对已存在目录静默成功,随机名
  // 碰撞/预占时会覆盖既有目录、失败清理再整树误删。非递归 mkdir EEXIST 换名重试;清理只删
  // 自己认领到的目录。
  try {
    fs.mkdirSync(path.join(alphaGlobalRoot(), "plugins"), { recursive: true })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to prepare plugins root" }
  }
  let destDir: string | null = null
  for (let attempt = 0; attempt < 3 && destDir === null; attempt++) {
    const versioned = `${name}@${crypto.randomBytes(4).toString("hex")}`
    const candidate = safeResolveUnder(alphaGlobalRoot(), "plugins", versioned)
    if (!candidate) return { ok: false, reason: "refused: path escapes alpha root" }
    try {
      fs.mkdirSync(candidate) // 非递归:已存在 = EEXIST,绝不复用他人目录
      destDir = candidate
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
        return { ok: false, reason: error instanceof Error ? error.message : "failed to claim staging dir" }
    }
  }
  if (destDir === null) return { ok: false, reason: "failed to claim a fresh versioned staging dir (3 attempts)" }
  try {
    for (const f of files) {
      const target = safeResolveUnder(destDir, ...f.path.split("/"))
      if (!target) throw new Error(`refused: payload path escapes staging dir: ${f.path}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.data)
    }
  } catch (error) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true }) // 本次排他认领的目录,删除不伤他人
    } catch {
      /* 半成品残留无 config 引用 */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to stage plugin" }
  }
  return { ok: true, dir: destDir, jsPath: path.join(destDir, "plugin.js") }
}

/** vendored plugin 载荷单文件帽(与引擎 file action 的 16MB 界一致,提前可读拒绝)+ 总量帽
 *  (内存态采集,防随包资产异常膨胀拖垮 main)。 */
const VENDORED_PLUGIN_FILE_MAX_BYTES = 16 * 1024 * 1024
const VENDORED_PLUGIN_TOTAL_MAX_BYTES = 64 * 1024 * 1024

/** #378(Codex 裁决 D2):收集 vendored plugin 随包目录为原始载荷 —— CAS 摄取源(自算内容地址,
 *  摄取后完整性),事务 file items 由 planner 复用 seed 载体构造。只读零副作用;旧 flat 写入器
 *  installVendoredPlugin 随 planner seam 下线删除(D8:无生产调用面)。
 *  圈禁:srcDir realpath 必须恰为 <realpath(resources)>/<key>(父链 symlink 拒,#361 同款);
 *  树内 symlink/非常规条目拒(collectSkillPayloadFromDir 同纪律);单文件/总量帽提前拒。 */
export function collectVendoredPluginPayload(
  vendoredAssetKey: string,
  name: string,
): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string } {
  if (!isExtensionAssetKey(vendoredAssetKey, "plugins")) return { ok: false, reason: "invalid asset key" }
  if (!isExtensionName(name)) return { ok: false, reason: "invalid plugin name" }
  // #378 r5(Major):内容身份交叉(#361 agent 同款)—— 已验签但配错的 entry 不得把别的资产
  // 目录按本 plugin 的名称/账本身份/capability grant 装入运行。
  if (vendoredAssetKey !== `plugins/${name}`)
    return { ok: false, reason: `asset key "${vendoredAssetKey}" ≠ "plugins/${name}" — refusing (content identity drift)` }
  const srcDir = path.join(resourcesRoot(), vendoredAssetKey)
  let realSrc: string
  try {
    realSrc = fs.realpathSync(srcDir)
    const expected = path.join(fs.realpathSync(resourcesRoot()), ...vendoredAssetKey.split("/"))
    if (realSrc !== expected) return { ok: false, reason: "plugin asset escapes the resources tree (symlinked path) — refusing" }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ENOENT") return { ok: false, reason: "插件内容未随此版本打包" }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read plugin asset" }
  }
  // r17(Major):帽下沉到共享收集器的 fstat 前置检查(读入内存前拒);下方循环保留为二道闸
  // (消息与既有拒绝语义位)。
  const collected = collectSkillPayloadFromDir(realSrc, { maxFileBytes: VENDORED_PLUGIN_FILE_MAX_BYTES, maxTotalBytes: VENDORED_PLUGIN_TOTAL_MAX_BYTES })
  if (!collected.ok) return collected
  if (!collected.files.some((f) => f.path === "plugin.js")) return { ok: false, reason: "插件内容未随此版本打包" }
  let total = 0
  for (const f of collected.files) {
    if (f.data.length > VENDORED_PLUGIN_FILE_MAX_BYTES)
      return { ok: false, reason: `plugin payload file "${f.path}" exceeds ${VENDORED_PLUGIN_FILE_MAX_BYTES} bytes — refused` }
    total += f.data.length
    if (total > VENDORED_PLUGIN_TOTAL_MAX_BYTES)
      return { ok: false, reason: `plugin payload exceeds ${VENDORED_PLUGIN_TOTAL_MAX_BYTES} bytes total — refused` }
  }
  return collected
}
