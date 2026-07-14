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

import * as fs from "node:fs"
import * as path from "node:path"

const MCP_SECRET_DIR = "alpha-mcp-secrets"
const SAFE_SERVER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_VAR = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

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

/** Remove a connector's whole secret dir on uninstall (revoke — no stale token resurrection). */
export function removeMcpServerSecrets(userDataPath: string, server: string): void {
  if (!SAFE_SERVER.test(server)) return
  try {
    fs.rmSync(serverDir(userDataPath, server), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * In-place: for each secret VAR in `secretVars`, move server.environment[VAR] (a real value the
 * renderer just collected) into the file channel and replace it with a `{file:}` ref — so the
 * durable config never carries the plaintext. Values already file-refs are left as-is. Returns the
 * list of vars actually file-ified (for logging by NAME only — never the value).
 */
/**
 * REQ-099 #305(catalog/planner 专用):按「变量名 → 真值」把密钥路由进文件通道,同时覆盖
 * environment(键匹配)与 headers(值内嵌 —— headersTemplate 的 {VAR} 已被替换成真值,按真值
 * 子串换成 {file:} 引用;引擎 ConfigVariable.substitute 对整份 config 文本做替换,headers 内
 * 引用同样解析)。真值来自 grants(planner 已拒 {file:}/{env:} 语法),一律按字面密钥写文件 ——
 * 不承认 renderer 侧「已有引用」。返回 refs 供调用方把 live 配置换回真值;granted 却没落到任何
 * 字段的密钥进 skipped,由调用方 fail-closed(绝不明文持久化)。
 */
export function fileifyMcpSecretsDeep(
  userDataPath: string,
  server: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): { fileified: string[]; skipped: string[]; refs: Record<string, string> } {
  const fileified: string[] = []
  const skipped: string[] = []
  const refs: Record<string, string> = {}
  const env = config.environment && typeof config.environment === "object" && !Array.isArray(config.environment)
    ? (config.environment as Record<string, unknown>)
    : null
  const headers = config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
    ? (config.headers as Record<string, unknown>)
    : null
  for (const [varName, real] of Object.entries(secrets)) {
    if (typeof real !== "string" || real.length === 0) continue // 空值 = 无可路由(调用方已过滤)
    const written = writeMcpSecret(userDataPath, server, varName, real)
    if (!written.ok) {
      skipped.push(varName)
      continue
    }
    let replaced = false
    if (env && env[varName] === real) {
      env[varName] = written.ref
      replaced = true
    }
    if (headers) {
      for (const [hk, hv] of Object.entries(headers)) {
        if (typeof hv === "string" && hv.includes(real)) {
          headers[hk] = hv.split(real).join(written.ref)
          replaced = true
        }
      }
    }
    if (replaced) {
      fileified.push(varName)
      refs[varName] = written.ref
    } else {
      skipped.push(varName) // granted 但没落到任何 config 字段 —— 视为异常,调用方 fail-closed
    }
  }
  return { fileified, skipped, refs }
}

export function fileifyMcpSecrets(
  userDataPath: string,
  server: string,
  config: Record<string, unknown>,
  secretVars: string[],
): { fileified: string[]; skipped: string[] } {
  const env = config.environment
  const fileified: string[] = []
  const skipped: string[] = []
  if (!env || typeof env !== "object" || Array.isArray(env)) return { fileified, skipped: secretVars }
  const envMap = env as Record<string, unknown>
  for (const varName of secretVars) {
    const value = envMap[varName]
    if (typeof value !== "string" || value.length === 0) {
      skipped.push(varName)
      continue
    }
    if (isFileRef(value)) {
      skipped.push(varName)
      continue
    }
    const written = writeMcpSecret(userDataPath, server, varName, value)
    if (written.ok) {
      envMap[varName] = written.ref
      fileified.push(varName)
    } else {
      skipped.push(varName)
    }
  }
  return { fileified, skipped }
}
