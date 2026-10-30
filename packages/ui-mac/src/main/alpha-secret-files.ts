// A6 (sidecar env allowlist): the {file:} secret channel that replaces secret env inheritance.
//
// Upstream spawns every MCP/LSP child with `{ ...process.env }` (mcp/index.ts:334, lsp/lsp.ts:176) —
// not editable under ADR-005. So secrets must never ENTER the sidecar's env at all. Instead:
//
//   main (spawnLocalServer, every fork/respawn)          sidecar (injectAlphaConfig)
//   ────────────────────────────────────────────         ─────────────────────────────────────────
//   syncSecretFiles(): mirror each secret env var   ──▶  hasSecretFile(): gate providers on FILE
//   into <userData>/alpha-secrets/<VAR> (0600),          presence (env no longer carries keys);
//   delete files whose var is gone (logout / key         secretFileRef(): emit "{file:<abs path>}"
//   removed), then fork with the ALLOWLISTED env          into OPENCODE_CONFIG_CONTENT. opencode's
//   (sidecar-env.ts) that excludes all of these.          ConfigVariable.substitute resolves it at
//                                                         config load — the value never hits env.
//
// This closes BOTH leak channels at once: (1) raw secret env vars inherited by children, and
// (2) OPENCODE_CONFIG_CONTENT itself — previously it carried inlined BYOK keys / a Bearer token and
// is also inherited by children; now it carries only file paths.
//
// Accepted residual risk: the files are 0600
// but a same-UID process that goes LOOKING can still read them — same exposure as alpha.env today.
// A6's target is the passive channel (children dumping/logging their env), which this eliminates.
//
// Electron-free on purpose: main calls syncSecretFiles; the sidecar (utilityProcess) reaches
// hasSecretFile/secretFileRef through alpha-models.ts/sidecar.ts.

import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { BYOK_ADAPTERS } from "./byok-adapters"

const SECRET_DIR = "alpha-secrets"

/** Every env var main materializes into the file channel: platform + cloud MCP + all catalog BYOK keys.
 * REQ-237 `#1556`:BYOK 的 Key 名只认 App 内置适配器表 —— 本集合同时是下方清理分支的 wanted 集,读错来源会把
 * 已配好的直连密钥文件当「退役」删掉。
 * `ALPHA_MCP_TOKEN`(#1195 / REQ-144 T2)= 登录铸的 `mcp_access` token(aud = 云 MCP resource),
 * 云 MCP 定义经 `{file:}` 引用消费它;缺席时本函数的删除分支负责把旧文件收走(登出/旧信封)。 */
export function secretEnvVars(): string[] {
  const byok = BYOK_ADAPTERS.map((adapter) => adapter.keyEnv)
  return ["ALPHA_API_KEY", "ALPHA_CLOUD_TOKEN", "ALPHA_MCP_TOKEN", ...byok]
}

/** REQ-226 (`#1343`): file name for an off-catalog custom provider's key in this channel. The id is already
 * limited by isExtensionName (no separators / braces / whitespace), and the lowercase prefix keeps these apart
 * from the ALL-CAPS catalog var names above. Main writes them from the keychain store (never env) via
 * `extra`; the sidecar gates the `{file:}` ref on the file's presence exactly like a catalog var. */
export const CUSTOM_PROVIDER_SECRET_PREFIX = "custom-provider--"
export function customProviderSecretName(providerId: string): string {
  return `${CUSTOM_PROVIDER_SECRET_PREFIX}${providerId}`
}

export function secretFilePath(userDataPath: string, varName: string): string {
  return path.join(userDataPath, SECRET_DIR, varName)
}

export function hasSecretFile(userDataPath: string, varName: string): boolean {
  return fs.existsSync(secretFilePath(userDataPath, varName))
}

/** The config token opencode resolves at load time (config/variable.ts). Paths may contain spaces
 * (…/Application Support/…) — the upstream matcher is `\{file:[^}]+\}`, so anything but `}` is fine. */
export function secretFileRef(userDataPath: string, varName: string): string {
  return `{file:${secretFilePath(userDataPath, varName)}}`
}

export type SecretSyncResult = { written: string[]; removed: string[] }

/**
 * Mirror the secret env vars into <userData>/alpha-secrets, one file per var (0600, dir 0700).
 * Vars absent/empty in `env` get their file DELETED — logout and key-removal must revoke, or a stale
 * file would keep resurrecting a dead provider. Unknown leftover files (catalog removals) are also
 * swept. Values never touch the log — callers may log the returned NAMES only.
 *
 * `extra` (REQ-226 `#1343`): name → value pairs that do NOT come from env — today the off-catalog custom
 * provider keys main pulls from the keychain store (customProviderSecretValues). They join the wanted
 * set, so the leftover sweep keeps them; a name absent from `extra` on the next sync (key removed,
 * provider removed, store cleared) is swept like any retired var — one revocation semantics for all.
 */
export function syncSecretFiles(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): SecretSyncResult {
  const dir = path.join(userDataPath, SECRET_DIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700) // mkdirSync's mode is ignored when the dir already exists

  const written: string[] = []
  const removed: string[] = []
  const wanted = new Set<string>()

  for (const name of secretEnvVars()) {
    const value = env[name]
    const file = path.join(dir, name)
    if (value) {
      wanted.add(name)
      writeSecretFileAtomic(dir, name, value)
      written.push(name)
      continue
    }
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removed.push(name)
    }
  }

  for (const [name, value] of Object.entries(extra)) {
    // Fail closed on a name that is not a plain file name: the caller (spawnLocalServer) refuses the fork.
    if (!name || name !== path.basename(name) || name !== name.trim())
      throw new Error("alpha-secrets: refusing an extra secret whose name is not a plain file name")
    if (!value) continue // absent ⇒ swept below like a retired var
    wanted.add(name)
    writeSecretFileAtomic(dir, name, value)
    written.push(name)
  }

  for (const leftover of fs.readdirSync(dir)) {
    if (wanted.has(leftover)) continue
    if (removed.includes(leftover)) continue
    fs.rmSync(path.join(dir, leftover), { force: true })
    removed.push(leftover)
  }

  return { written, removed }
}

/**
 * REQ-236 §2.1-1 / I2(`#1562`):秘密文件的唯一写法。续期热应用之后引擎在**每次请求**现读这些文件
 * (ext `chat.headers` 与引擎云 MCP 的 fetch 包装),截断后写会让读者撞上半个令牌;同目录临时文件写满、
 * 0600、fsync 后 rename 覆盖,读者只会看到完整的旧值或新值。临时文件名以点开头且带随机后缀,
 * 写失败时删掉它,不留半截文件(残留也会被下一次 syncSecretFiles 的清扫收走)。
 */
export function writeSecretFileAtomic(dir: string, name: string, value: string): void {
  const file = path.join(dir, name)
  const temp = path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    const fd = fs.openSync(temp, "wx", 0o600)
    try {
      fs.writeFileSync(fd, value)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(temp, 0o600)
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/** 续期热应用只重写这两份:平台模型请求(ext `chat.headers` 经 `ALPHA_PLATFORM_AUTH_REF`)与云 MCP
 *  (引擎 fetch 包装经 `ALPHA_CLOUD_MCP_DEF` 里的引用)在请求边界现读它们。 */
const HOT_CREDENTIALS = ["ALPHA_API_KEY", "ALPHA_MCP_TOKEN"] as const

export type HotApplyOutcome = "applied" | "needs-structural"

/**
 * REQ-236 §2.1-1(`#1562`):同身份续期把新凭据原子写进文件,不重启引擎。
 *
 * `forked` = 最近一次 fork 时 `syncSecretFiles` 写入的名字(server.ts 记录);还没 fork 过 ⇒ 直接
 * `applied`,下一次 fork 的 syncSecretFiles 自然带上 env 里的新值。两份热凭据的在场集合与 fork 时不同
 * (凭据出现或消失)⇒ `needs-structural`:平台 provider 与云 MCP 条目是否存在是 fork 时定的,热写改不了。
 * 任一写入或回读摘要不一致 ⇒ `needs-structural`(热写失败,由结构性重启的 syncSecretFiles 再写一次)。
 * 只返回结论,不记录任何值。
 */
export function applyPlatformCredentialsHot(
  userDataPath: string,
  env: NodeJS.ProcessEnv,
  forked: ReadonlySet<string> | undefined,
): HotApplyOutcome {
  if (!forked) return "applied"
  const present = HOT_CREDENTIALS.filter((name) => env[name])
  if (present.length !== HOT_CREDENTIALS.filter((name) => forked.has(name)).length) return "needs-structural"
  if (present.some((name) => !forked.has(name))) return "needs-structural"
  const dir = path.join(userDataPath, SECRET_DIR)
  try {
    for (const name of present) {
      const value = env[name]!
      writeSecretFileAtomic(dir, name, value)
      if (digest(fs.readFileSync(path.join(dir, name), "utf8")) !== digest(value)) return "needs-structural"
    }
  } catch {
    return "needs-structural"
  }
  return "applied"
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
