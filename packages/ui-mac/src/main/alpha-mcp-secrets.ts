// MCP connector secrets → {file:} channel (REQ-018 T5). Catalog connectors that need a token
// (GITHUB_PERSONAL_ACCESS_TOKEN, APP_ID/APP_SECRET, YUQUE_TOKEN, …) must NOT land as plaintext in
// opencode.jsonc. Instead each secret value is written to <userData>/alpha-mcp-secrets/<server>/<VAR>
// (0600) and the config carries only a `{file:<abs path>}` reference — opencode's ConfigVariable
// substitution resolves it at config load (same mechanism A6 uses for the platform/cloud keys,
// alpha-secret-files.ts). Kept in its OWN dir so syncSecretFiles (which sweeps alpha-secrets/) never
// touches these per-connector files.
//
// Electron-free (takes userDataPath) so it is unit-testable; the ext IPC handler passes
// app.getPath("userData").

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const MCP_SECRET_DIR = "alpha-mcp-secrets"
const SAFE_SERVER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_VAR = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
// #378(Codex 裁决 Q1):版本目录名与 server/VAR 名字空间互斥(SAFE_SERVER 不含 "v-" 前缀约束,
// 但 SAFE_VAR 不允许 "-",且版本目录固定 v- 前缀 + hex),GC 枚举据此判别三类条目。
// review r1 Minor:64 位随机 + **排他 claim**(claimMcpSecretVersionDir)—— 碰撞不再静默复用
// 既有版本目录(那会经 rename 覆盖旧配置正在引用的密钥,破坏 append-only)。
const SAFE_SECRET_VER = /^v-[a-f0-9]{8,16}$/
/** 版本目录 GC 宽限:mtime 新于此值的未引用条目不删 —— 保护「文件已写、config 尚未提交」的
 *  在途安装(写文件不持配置锁,见 gcMcpSecretVersionsLocked 合同)。 */
const SECRET_GC_GRACE_MS = 10 * 60 * 1000

/** True for a value already routed through the file channel — don't double-wrap or treat as plaintext. */
export function isFileRef(value: string): boolean {
  return /^\{file:.+\}$/.test(value)
}

function serverDir(userDataPath: string, server: string): string {
  return path.join(userDataPath, MCP_SECRET_DIR, server)
}

/** The `{file:<abs path>}` token opencode resolves at config load (config/variable.ts). */
export function mcpSecretRef(userDataPath: string, server: string, varName: string): string {
  return `{file:${path.join(serverDir(userDataPath, server), varName)}}`
}

/**
 * Write one connector secret (0600, dir 0700) and return its `{file:}` reference. Rejects unsafe
 * server/var names and empty values (nothing to store → caller keeps the field out of config).
 */
export function writeMcpSecret(
  userDataPath: string,
  server: string,
  varName: string,
  value: string,
): { ok: true; ref: string } | { ok: false; reason: string } {
  if (!SAFE_SERVER.test(server)) return { ok: false, reason: "invalid server name" }
  if (!SAFE_VAR.test(varName)) return { ok: false, reason: `invalid env var name: ${varName}` }
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "empty secret value" }
  try {
    const dir = serverDir(userDataPath, server)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700) // mkdir mode ignored when dir already exists
    const file = path.join(dir, varName)
    fs.writeFileSync(file, value, { mode: 0o600 })
    fs.chmodSync(file, 0o600) // writeFile mode ignored when file already exists
    return { ok: true, ref: mcpSecretRef(userDataPath, server, varName) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write secret" }
  }
}

/** #378 r3(Major):历史快照实现把备份放在 **server 目录的兄弟级**(已退役的
 *  snapshotMcpServerSecretsStrict:`${dir}.bak-${randomBytes(4).hex}` = 恰 `<server>.bak-<hex8>`)
 *  —— 吊销/GC 都必须覆盖这一层,否则含密钥的旧备份在卸载与成功重装后永久残留。
 *  r4(Major):后缀按历史实现**精确匹配** `.bak-<hex8>` —— 裸前缀会把碰巧叫
 *  `<server>.bak-live` 的另一个合法 server(SAFE_SERVER 允许点与连字符)的**在用密钥目录**
 *  误判成备份删除。枚举失败走结果通道(strict 调用方必须失败,best-effort 调用方静默);
 *  ENOENT = 空。 */
const SIBLING_BAK_SUFFIX = /^\.bak-[a-f0-9]{8}$/
/** r8(Major):名字模式仍可能撞真 server(`foo.bak-<hex8>` 是 SAFE_SERVER 合法名)——
 *  isLiveServer(全配置源在册名集合)排除活体,只把「名字匹配且不在册」当历史备份。 */
function listSiblingBackupDirs(
  userDataPath: string,
  server: string,
  isLiveServer: (candidate: string) => boolean,
): { ok: true; dirs: string[] } | { ok: false; reason: string } {
  const base = path.join(userDataPath, MCP_SECRET_DIR)
  try {
    const dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.startsWith(server) &&
          SIBLING_BAK_SUFFIX.test(e.name.slice(server.length)) &&
          !isLiveServer(e.name),
      )
      .map((e) => path.join(base, e.name))
    return { ok: true, dirs }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ENOENT") return { ok: true, dirs: [] }
    return { ok: false, reason: `secret backup enumeration failed for ${server}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Remove a connector's whole secret dir on uninstall (revoke — no stale token resurrection).
 *  #378 r3:连同历史兄弟级 `<server>.bak-<hex8>` 快照残留一并吊销。 */
export function removeMcpServerSecrets(
  userDataPath: string,
  server: string,
  isLiveServer: (candidate: string) => boolean,
): void {
  if (!SAFE_SERVER.test(server)) return
  try {
    fs.rmSync(serverDir(userDataPath, server), { recursive: true, force: true })
    const baks = listSiblingBackupDirs(userDataPath, server, isLiveServer)
    if (baks.ok) for (const bak of baks.dirs) fs.rmSync(bak, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** #346:严格版密钥吊销 —— journaled 卸载事务/恢复期用。失败必须可观察(吞错会让「密钥已净除」
 *  不可证明,journal 无法据实保持非终态)。目录不存在 = 幂等成功。
 *  #378 r3/r4:兄弟级 `<server>.bak-<hex8>` 历史快照残留同吊销;**枚举失败 = 吊销失败**
 *  (静默折叠成功会让卸载终态化而旧凭证备份仍在盘上)。 */
export function removeMcpServerSecretsStrict(
  userDataPath: string,
  server: string,
  isLiveServer: (candidate: string) => boolean,
): { ok: true } | { ok: false; reason: string } {
  if (!SAFE_SERVER.test(server)) return { ok: false, reason: `invalid server name: ${server}` }
  try {
    fs.rmSync(serverDir(userDataPath, server), { recursive: true, force: true })
    const baks = listSiblingBackupDirs(userDataPath, server, isLiveServer)
    if (!baks.ok) return { ok: false, reason: `secret revocation incomplete for ${server}: ${baks.reason}` }
    for (const bak of baks.dirs) fs.rmSync(bak, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `secret revocation failed for ${server}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// #378(Codex 裁决 Q1)注:REQ-099 #305 的 fileifyMcpSecretsDeep(catalog 深路由 + 整目录快照)
// 与 #342/#354 的 snapshotMcpServerSecrets(Strict) 已退役 —— 固定路径覆盖写 + 快照/恢复被版本化
// 只增布局取代(catalog 走 substituteMcpSecretRefsPure + writeMcpSecretVersioned,失败删本次
// verId;跨通道整目录 restore 会删掉并发事务的新版本,正是被裁决否决的交错)。

/** #378 r8(Blocker):未策展通道的版本化 fileify —— 返回 **failed**(明文在场但没能进文件
 *  通道:写失败/env 缺失形状异常),调用方必须 fail-closed 拒绝落盘(durable config 只含
 *  {file:} 引用的合同对未策展面同样成立);已是 {file:} 引用 / 空值 = 良性跳过(无明文风险),
 *  不再与失败混在一个桶里。写入走 writeMcpSecretVersioned(新 verId 目录,旧版本零接触)。 */
export function fileifyMcpSecretsVersioned(
  userDataPath: string,
  server: string,
  config: Record<string, unknown>,
  secretVars: string[],
  verId: string,
): { fileified: string[]; failed: string[] } {
  const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  const fileified: string[] = []
  const failed: string[] = []
  const envMap = isRec(config.environment) ? config.environment : null
  for (const varName of secretVars) {
    const value = envMap ? envMap[varName] : undefined
    if (typeof value !== "string" || value.length === 0 || isFileRef(value)) continue // 良性:无明文可路由
    if (!envMap) {
      failed.push(varName)
      continue
    }
    const written = writeMcpSecretVersioned(userDataPath, server, verId, varName, value)
    if (written.ok) {
      envMap[varName] = written.ref
      fileified.push(varName)
    } else {
      failed.push(varName)
    }
  }
  return { fileified, failed }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// #378(Codex 裁决 Q1):版本化密钥布局 `<userData>/alpha-mcp-secrets/<server>/<verId>/<VAR>`。
// 固定路径覆盖写被否决 —— 事务(config action)与未策展通道都改为**只增不覆盖**:每次安装尝试
// 写全新 verId 目录,旧版本文件零接触(旧 config 的 {file:} 引用直至新 config 提交前始终有效);
// 失败/authorize 暂停删本次 verId(无引用,惰性);成功后由 gcMcpSecretVersionsLocked 在配置锁内
// 按「当前 leaf 引用 + mtime 宽限」收未引用版本与旧 flat 布局残留。崩溃孤儿同样无引用,GC 收。
// 卸载不变:removeMcpServerSecrets(Strict) 整 server 目录(覆盖全部版本 + flat + 快照残留)。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** 新安装尝试的版本 id(每次调用新目录;不可预测性不承载安全属性,只求不碰撞 ——
 *  碰撞的最终防线是 claimMcpSecretVersionDir 的排他 mkdir)。 */
export function newMcpSecretVersionId(): string {
  return `v-${crypto.randomBytes(8).toString("hex")}`
}

/** 排他认领本次安装尝试的版本目录(#378 r1 Minor):非递归 mkdir,已存在(哪怕碰巧同名)
 *  = 认领失败,调用方换新 verId 重试 —— 绝不复用既有版本目录(append-only 的最终强制)。
 *  父级(根/server)经 ensureRealDir 圈禁。 */
export function claimMcpSecretVersionDir(
  userDataPath: string,
  server: string,
  verId: string,
): { ok: true } | { ok: false; exists: boolean; reason: string } {
  if (!SAFE_SERVER.test(server)) return { ok: false, exists: false, reason: "invalid server name" }
  if (!SAFE_SECRET_VER.test(verId)) return { ok: false, exists: false, reason: `invalid secret version id: ${verId}` }
  const sDir = serverDir(userDataPath, server)
  for (const dir of [path.join(userDataPath, MCP_SECRET_DIR), sDir]) {
    const ensured = ensureRealDir(dir)
    if (!ensured.ok) return { ok: false, exists: false, reason: ensured.reason }
  }
  try {
    fs.mkdirSync(path.join(sDir, verId), { mode: 0o700 }) // 非递归 = 排他(EEXIST 即被占)
    return { ok: true }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "EEXIST") return { ok: false, exists: true, reason: `secret version dir already exists: ${verId}` }
    return { ok: false, exists: false, reason: error instanceof Error ? error.message : "failed to claim secret version dir" }
  }
}

/** 版本化 `{file:}` 引用(纯路径推导,零写盘 —— planner 先构造 durable config,落盘另走
 *  writeMcpSecretVersioned;两者必须同参调用)。 */
export function mcpSecretVersionedRef(userDataPath: string, server: string, verId: string, varName: string): string {
  return `{file:${path.join(serverDir(userDataPath, server), verId, varName)}}`
}

/** 组件必须是**非 symlink 实目录**(裁决结构性风险 1:裸 writeFileSync 无圈禁可被 server 目录 /
 *  VAR symlink 引出树外)。次序合同(#378 review r1 Major):**先 lstat 验非链,后 chmod** ——
 *  chmod 追链,若先执行会在拒绝恶意布局前把链接目标目录权限改掉(圈禁外副作用);mkdir 对已
 *  存在路径零写入,可先行。验后 chmod 与末次 lstat 之间的换链窗口与 #361 同类缩窗(能写
 *  userData 者本就等价于本用户)。 */
function ensureRealDir(dir: string): { ok: true } | { ok: false; reason: string } {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) // 已存在(含链)时零副作用
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${path.basename(dir)} is not a real directory — refusing (symlink hazard)` }
    fs.chmodSync(dir, 0o700) // 已验非链才 chmod(mkdir mode 对既有目录无效)
    const st2 = fs.lstatSync(dir)
    if (st2.isSymbolicLink() || !st2.isDirectory()) return { ok: false, reason: `${path.basename(dir)} is not a real directory — refusing (symlink hazard)` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to create secret dir" }
  }
}

/**
 * 硬化版密钥写(#378):版本目录内 tmp(0600)→ rename 原子落位;写前 lstat 圈禁根/server/版本
 * 三级目录均为非 symlink 实目录。绝不触碰其他版本/flat 文件。
 */
export function writeMcpSecretVersioned(
  userDataPath: string,
  server: string,
  verId: string,
  varName: string,
  value: string,
): { ok: true; ref: string } | { ok: false; reason: string } {
  if (!SAFE_SERVER.test(server)) return { ok: false, reason: "invalid server name" }
  if (!SAFE_SECRET_VER.test(verId)) return { ok: false, reason: `invalid secret version id: ${verId}` }
  if (!SAFE_VAR.test(varName)) return { ok: false, reason: `invalid env var name: ${varName}` }
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "empty secret value" }
  const root = path.join(userDataPath, MCP_SECRET_DIR)
  const sDir = serverDir(userDataPath, server)
  const vDir = path.join(sDir, verId)
  for (const dir of [root, sDir, vDir]) {
    const ensured = ensureRealDir(dir)
    if (!ensured.ok) return ensured
  }
  const tmp = path.join(vDir, `.tmp-${crypto.randomBytes(4).toString("hex")}`)
  try {
    fs.writeFileSync(tmp, value, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, path.join(vDir, varName)) // 同目录 rename:原子,且替换目录项本身不追 symlink
    return { ok: true, ref: mcpSecretVersionedRef(userDataPath, server, verId, varName) }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* tmp 残留在 0700 版本目录内,GC 收 */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write secret" }
  }
}

/** 删除**本次安装尝试**的版本目录(失败/authorize 暂停清理;目录无任何 config 引用,删除惰性安全)。
 *  幂等:不存在 = ok。 */
export function removeMcpSecretVersionDir(
  userDataPath: string,
  server: string,
  verId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!SAFE_SERVER.test(server)) return { ok: false, reason: "invalid server name" }
  if (!SAFE_SECRET_VER.test(verId)) return { ok: false, reason: `invalid secret version id: ${verId}` }
  try {
    fs.rmSync(path.join(serverDir(userDataPath, server), verId), { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to remove secret version dir" }
  }
}

/**
 * 纯引用替换(#378,fileifyMcpSecretsDeep 的零写盘半身):按「变量名 → 真值」把 environment
 * 键匹配值与 headers 内嵌真值换成 refFor(varName) 引用。**原地修改 config**(与 fileify 同约定,
 * 调用方传入自己的深拷贝)。granted 但没落到任何字段 → skipped(调用方 fail-closed 拒明文持久化);
 * 空值同样 skipped(无可路由)。落盘由调用方对 substituted 的每个变量另调 writeMcpSecretVersioned。
 */
export function substituteMcpSecretRefsPure(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  refFor: (varName: string) => string,
): { substituted: Record<string, string>; skipped: string[] } {
  const substituted: Record<string, string> = {}
  const skipped: string[] = []
  const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  const env = isRec(config.environment) ? config.environment : null
  const headers = isRec(config.headers) ? config.headers : null
  for (const [varName, real] of Object.entries(secrets)) {
    if (typeof real !== "string" || real.length === 0) {
      skipped.push(varName)
      continue
    }
    const ref = refFor(varName)
    let replaced = false
    if (env && env[varName] === real) {
      env[varName] = ref
      replaced = true
    }
    if (headers) {
      for (const [hk, hv] of Object.entries(headers)) {
        if (typeof hv === "string" && hv.includes(real)) {
          headers[hk] = hv.split(real).join(ref)
          replaced = true
        }
      }
    }
    if (replaced) substituted[varName] = ref
    else skipped.push(varName)
  }
  return { substituted, skipped }
}

/** #378 r13/r14:路径的文件系统身份形态集 —— 词法 resolve + realpath(存在时)。
 *  symlink/卷别名(大小写、NFD)会让纯词法比较漏判「同一文件」;引用对账/条目匹配统一
 *  用双形态交集判定(任一形态相等即同一身份)。 */
export function pathIdentityForms(p: string): string[] {
  const lex = path.resolve(p)
  try {
    const real = fs.realpathSync(lex)
    return real === lex ? [lex] : [lex, real]
  } catch {
    return [lex]
  }
}

/** #378 r5(Major):{file:} 引用路径 → **引擎解析语义**的绝对路径(config/variable.ts:先展开
 *  `~/` 为 home,再按 config 文件所在目录 resolve 相对路径)—— GC 与失败清理的引用对账必须与
 *  引擎同判,否则 `{file:~/...}` 等合法形态被误判未引用而删掉在用密钥。 */
export function resolveMcpRefPath(p: string, configDir: string): string {
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(configDir, expanded)
}

/** 深收集一个 config 值里的全部 `{file:<path>}` 引用路径(GC 的「被引用」判据;env 精确值与
 *  headers 内嵌都覆盖 —— 对任意深度字符串值做 token 抽取,宁多算不漏算)。 */
export function collectMcpFileRefPaths(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{file:([^}]+)\}/g)) {
        const p = m[1]
        if (p) out.push(p)
      }
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    if (v && typeof v === "object") for (const item of Object.values(v)) walk(item)
  }
  walk(value)
  return out
}

/**
 * 提交后版本 GC(#378)。**调用方必须持配置写锁**(referencedPaths 从锁内读出的当前 mcp.<server>
 * leaf 收集 —— 锁保证引用集与 config 现状一致;命名合同对标 gcVendoredPluginDirLocked)。
 * 删除三类未引用且 mtime 早于宽限期的条目:版本目录(整目录任一文件被引用即整目录保留)、
 * legacy flat 密钥文件、历史快照残留(.bak-*)。宽限期保护「文件已写、config 未提交」的在途
 * 安装(写文件不持锁,见模块头)。best-effort:单条失败进 warnings,绝不抛。
 */
export function gcMcpSecretVersionsLocked(
  userDataPath: string,
  server: string,
  referencedPaths: string[],
  // r8:兄弟备份的活体排除(在册 server 名);缺省无排除只在名字不可能撞库的测试场景使用。
  isLiveServer: (candidate: string) => boolean = () => false,
): { removed: string[]; warnings: string[] } {
  const removed: string[] = []
  const warnings: string[] = []
  if (!SAFE_SERVER.test(server)) return { removed, warnings: [`invalid server name: ${server}`] }
  const sDir = serverDir(userDataPath, server)
  // r13 Major:引用可能经 symlink 别名到达版本文件 —— 词法 resolve 不够,补文件系统身份
  // (realpath;引用目标缺席时保留词法形态)。候选文件比较时同样双形态查询。
  const referenced = new Set<string>()
  for (const rp of referencedPaths) {
    const lex = path.resolve(rp)
    referenced.add(lex)
    try {
      referenced.add(fs.realpathSync(lex))
    } catch {
      /* 引用目标缺席:词法形态已入集 */
    }
  }
  const isReferencedFile = (abs: string): boolean => {
    if (referenced.has(path.resolve(abs))) return true
    try {
      return referenced.has(fs.realpathSync(abs))
    } catch {
      return false
    }
  }
  const cutoff = Date.now() - SECRET_GC_GRACE_MS
  const olderThanGrace = (p: string): boolean => {
    try {
      return fs.lstatSync(p).mtimeMs < cutoff
    } catch {
      return false // 读不到 mtime = 不删(fail-safe)
    }
  }
  // #378 r3(Major):历史快照实现的备份在 **server 目录兄弟级**(`<server>.bak-<hex8>`)——
  // 只扫 server 目录内层永远看不见它们,含密钥旧备份会在成功重装后永久残留。过宽限即收
  // (备份从不被 config 引用)。与 server 目录是否存在无关;枚举失败入 warnings(best-effort)。
  const baks = listSiblingBackupDirs(userDataPath, server, isLiveServer)
  if (!baks.ok) warnings.push(baks.reason)
  else
    for (const bak of baks.dirs) {
      try {
        if (olderThanGrace(bak)) {
          fs.rmSync(bak, { recursive: true, force: true })
          removed.push(bak)
        }
      } catch (error) {
        warnings.push(`secret gc failed for ${bak}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(sDir, { withFileTypes: true })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ENOENT") return { removed, warnings }
    warnings.push(`secret dir unreadable for ${server}: ${error instanceof Error ? error.message : String(error)}`)
    return { removed, warnings }
  }
  for (const entry of entries) {
    const full = path.join(sDir, entry.name)
    try {
      if (entry.isDirectory() && SAFE_SECRET_VER.test(entry.name)) {
        const files = fs.readdirSync(full)
        const inUse = files.some((f) => isReferencedFile(path.join(full, f)))
        if (!inUse && olderThanGrace(full)) {
          fs.rmSync(full, { recursive: true, force: true })
          removed.push(full)
        }
      } else if (entry.isFile() && SAFE_VAR.test(entry.name)) {
        if (!isReferencedFile(full) && olderThanGrace(full)) {
          fs.rmSync(full, { force: true })
          removed.push(full)
        }
      }
      // 其余形态(symlink/未知名)零接触 —— GC 只收自己认识的布局。
    } catch (error) {
      warnings.push(`secret gc failed for ${full}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { removed, warnings }
}
