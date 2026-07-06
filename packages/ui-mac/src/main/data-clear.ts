// data-clear —— C16 数据清除逻辑核(electron-free,依赖全注入以便单测;对话框/菜单接线在
// data-clear-boot.ts)。分级:credentials(凭证)⊂ data(全部数据,为卸载做准备)。
//
// 安全边界(fail-closed,与 REQ-044 provenance 同一纪律):
//   - 只删白名单根(userData / ~/.alpha / 引擎数据目录)内的路径,executeClear 逐项 realpath 复核,
//     越界一律拒删(失败留痕,不静默);
//   - symlink 永不跟随:lstat 语义,删链只删链本身;
//   - `~/.opencode` 里只摘 alpha 自有的 symlink(目标解析进 ~/.alpha 才算),真实文件/外来链一律不碰
//     (ADR-019 §4:用户自建内容不迁移、不接管、更不删除);
//   - 引擎数据目录(XDG …/opencode,含会话 DB 与引擎 auth.json)与独立安装的 opencode CLI 共享,
//     删除必须由调用方显式 opt-in(includeShared),对话框文案如实告知。
//
// 路径规则契约锚(与 db-safety.ts 同源):引擎数据 = $XDG_DATA_HOME || ~/.local/share + /opencode
// ⇔ packages/core/src/database/database.ts:path()。

import * as path from "node:path"

export type ClearLevel = "credentials" | "data"

export type ClearRoots = {
  userData: string
  alphaGlobal: string // alphaGlobalRoot() —— ~/.alpha
  opencodeHome: string // opencodeHomeDir() —— ~/.opencode(只摘自有链,不作删除根)
  engineData: string // XDG …/opencode(共享面,须 opt-in)
}

export function engineDataDir(env: Record<string, string | undefined>, home: string): string {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")
}

export type LstatInfo = { isSymlink: boolean; isDir: boolean; size: number }

export type FsDeps = {
  exists(p: string): boolean
  /** lstat 语义(不跟随 symlink);不存在返回 null。 */
  lstat(p: string): LstatInfo | null
  readdir(p: string): string[]
  readlink(p: string): string | null
  realpath(p: string): string | null
  /** rm -rf --force 语义;对 symlink 只删链本身。 */
  remove(p: string): void
}

// ── 清单(单一真源:docs/UNINSTALL.md 的路径清单由此派生,改这里必须同步文档)────────────
export type ManifestItem = {
  id: string
  root: keyof ClearRoots
  rel: string
  desc: string
  /** 与独立 opencode CLI 共享的路径 —— 删除须显式 opt-in。 */
  shared?: boolean
}

export const CREDENTIAL_ITEMS: ManifestItem[] = [
  { id: "alpha-auth", root: "userData", rel: "alpha-auth.json", desc: "平台登录 token(safeStorage 加密)" },
  { id: "alpha-pkce", root: "userData", rel: "alpha-pkce.json", desc: "登录握手临时凭证(PKCE)" },
  { id: "byok-keys", root: "userData", rel: "alpha-byok-keys.json", desc: "BYOK 密钥库(safeStorage 加密)" },
  { id: "secret-files", root: "userData", rel: "alpha-secrets", desc: "密钥文件通道(A6 {file:})" },
  { id: "mcp-secrets", root: "userData", rel: "alpha-mcp-secrets", desc: "连接器密钥({file:} 通道)" },
  { id: "alpha-env", root: "userData", rel: "alpha.env", desc: "手写密钥 env 文件(alpha.env)" },
  { id: "engine-auth", root: "engineData", rel: "auth.json", desc: "引擎凭证存储(与 opencode CLI 共享)", shared: true },
]

export type PlanItem = ManifestItem & { path: string; present: boolean; bytes: number }

export type ClearPlan = {
  items: PlanItem[]
  /** ~/.opencode 内解析进 ~/.alpha 的自有 symlink(全部数据级才摘)。 */
  bridgeLinks: string[]
  totalBytes: number
}

/** lstat 递归体积(不跟随 symlink,链按 0 计——目标不属于本项)。 */
export function sizeOf(fs: FsDeps, p: string): number {
  const info = fs.lstat(p)
  if (!info) return 0
  if (info.isSymlink) return 0
  if (!info.isDir) return info.size
  let total = 0
  for (const entry of safeReaddir(fs, p)) total += sizeOf(fs, path.join(p, entry))
  return total
}

function safeReaddir(fs: FsDeps, p: string): string[] {
  try {
    return fs.readdir(p)
  } catch {
    return []
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
  return `${Math.round((n / (1024 * 1024 * 1024)) * 100) / 100} GB`
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** symlink 目标解析(readlink 相对路径按链所在目录解析;目标可以已不存在)。 */
function resolveLinkTarget(fs: FsDeps, linkPath: string): string | null {
  const target = fs.readlink(linkPath)
  if (!target) return null
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(linkPath), target)
}

/**
 * `~/.opencode` 内 alpha 自有 symlink 扫描(深度 ≤2:kind 级整目录链 + kind 目录内逐条目链)。
 * 判据 = 链目标解析进 ~/.alpha(realpath 优先,目标已失效时退回字面解析)。真实文件/目录、
 * 目标在别处的链,一律不入列。
 */
export function findAlphaOwnedLinks(fs: FsDeps, opencodeHome: string, alphaGlobal: string): string[] {
  const alphaResolved = fs.realpath(alphaGlobal) ?? path.normalize(alphaGlobal)
  const owned: string[] = []
  const isOwnedLink = (p: string): boolean => {
    const info = fs.lstat(p)
    if (!info?.isSymlink) return false
    const target = fs.realpath(p) ?? resolveLinkTarget(fs, p)
    if (!target) return false
    return isInside(target, alphaResolved) || target === alphaResolved
  }
  for (const entry of safeReaddir(fs, opencodeHome)) {
    const level1 = path.join(opencodeHome, entry)
    if (isOwnedLink(level1)) {
      owned.push(level1)
      continue // 整目录链本身已覆盖其下所有条目
    }
    const info = fs.lstat(level1)
    if (!info || info.isSymlink || !info.isDir) continue
    for (const sub of safeReaddir(fs, level1)) {
      const level2 = path.join(level1, sub)
      if (isOwnedLink(level2)) owned.push(level2)
    }
  }
  return owned
}

/**
 * 计划(dry-run):列出将删项 + 体积。credentials = 白名单文件;data = credentials + userData 全部
 * 子项 + ~/.alpha 整根 + 引擎数据目录(shared,opt-in)+ 桥链。日志目录排到最后删(留痕窗口)。
 */
export function planClear(fs: FsDeps, level: ClearLevel, roots: ClearRoots): ClearPlan {
  const items: PlanItem[] = []
  const push = (m: ManifestItem) => {
    const p = path.join(roots[m.root], m.rel)
    items.push({ ...m, path: p, present: fs.lstat(p) !== null, bytes: sizeOf(fs, p) })
  }

  if (level === "credentials") {
    for (const m of CREDENTIAL_ITEMS) push(m)
    return { items, bridgeLinks: [], totalBytes: items.reduce((n, i) => n + i.bytes, 0) }
  }

  // data 级:userData 逐子项(而非整根删除——logs 需最后删,且逐项结果可留痕)
  const children = safeReaddir(fs, roots.userData).sort((a, b) => a.localeCompare(b))
  for (const child of children) {
    items.push({
      id: `userdata:${child}`,
      root: "userData",
      rel: child,
      desc: "应用数据(userData)",
      path: path.join(roots.userData, child),
      present: true,
      bytes: sizeOf(fs, path.join(roots.userData, child)),
    })
  }
  const alphaRoot: ManifestItem = { id: "alpha-global", root: "alphaGlobal", rel: ".", desc: "全局安装物与自动化(~/.alpha)" }
  push({ ...alphaRoot })
  const engineRoot: ManifestItem = {
    id: "engine-data",
    root: "engineData",
    rel: ".",
    desc: "引擎数据:会话数据库/项目元数据/引擎凭证(与 opencode CLI 共享)",
    shared: true,
  }
  push(engineRoot)

  // logs 目录排全批最后删:其余项的逐项结果先落 main.log,留痕窗口最大化
  items.sort((a, b) => Number(a.id === "userdata:logs") - Number(b.id === "userdata:logs"))

  const bridgeLinks = findAlphaOwnedLinks(fs, roots.opencodeHome, roots.alphaGlobal)
  return { items, bridgeLinks, totalBytes: items.reduce((n, i) => n + i.bytes, 0) }
}

export type ClearResultItem = { id: string; path: string; outcome: "ok" | "missing" | "failed" | "skipped"; error?: string }

/**
 * 执行清除。fail-closed:每项删除前 realpath 复核仍在白名单根内(防 TOCTOU 换链);shared 项仅在
 * includeShared 时删,否则记 skipped(不静默)。单项失败不中断批次,逐项结果交调用方留痕。
 */
export function executeClear(
  fs: FsDeps,
  plan: ClearPlan,
  roots: ClearRoots,
  opts: { includeShared: boolean },
): ClearResultItem[] {
  const guards = [roots.userData, roots.alphaGlobal, roots.engineData].map((r) => fs.realpath(r) ?? path.normalize(r))
  const results: ClearResultItem[] = []

  for (const item of plan.items) {
    if (!item.present && !fs.exists(item.path)) {
      results.push({ id: item.id, path: item.path, outcome: "missing" })
      continue
    }
    if (item.shared && !opts.includeShared) {
      results.push({ id: item.id, path: item.path, outcome: "skipped" })
      continue
    }
    // 复核:链不跟随(lstat 为链时删链本身,天然安全);实体路径 realpath 须在守卫根内
    const info = fs.lstat(item.path)
    if (info && !info.isSymlink) {
      const resolved = fs.realpath(item.path)
      const inGuard = resolved !== null && guards.some((g) => resolved === g || isInside(resolved, g))
      if (!inGuard) {
        results.push({ id: item.id, path: item.path, outcome: "failed", error: "resolved path escapes guard roots" })
        continue
      }
    }
    try {
      fs.remove(item.path)
      results.push({ id: item.id, path: item.path, outcome: fs.exists(item.path) ? "failed" : "ok" })
    } catch (error) {
      results.push({ id: item.id, path: item.path, outcome: "failed", error: String(error) })
    }
  }

  for (const link of plan.bridgeLinks) {
    const info = fs.lstat(link)
    if (!info) {
      results.push({ id: `bridge:${path.basename(link)}`, path: link, outcome: "missing" })
      continue
    }
    if (!info.isSymlink) {
      // 计划与执行之间被换成真实体 —— 拒删(用户内容红线)
      results.push({ id: `bridge:${path.basename(link)}`, path: link, outcome: "failed", error: "no longer a symlink" })
      continue
    }
    try {
      fs.remove(link)
      results.push({ id: `bridge:${path.basename(link)}`, path: link, outcome: "ok" })
    } catch (error) {
      results.push({ id: `bridge:${path.basename(link)}`, path: link, outcome: "failed", error: String(error) })
    }
  }

  return results
}
