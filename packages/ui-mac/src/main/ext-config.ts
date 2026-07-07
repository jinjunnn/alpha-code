// Extension Hub config writer (main process). Persists MCP servers to the user's global opencode
// config so they survive restart — opencode reads config once and caches it, so the renderer's live
// sdk.mcp.add covers "this session" while this covers "next launch". We replicate the CLI's
// jsonc-modify approach (packages/opencode/src/cli/cmd/mcp.ts) WITHOUT importing opencode internals
// at runtime (ADR-006): jsonc-parser only + Node built-ins.
//
// Security (ADR-014 §8): everything is validated before any disk I/O — the MCP name, the allowed
// config fields, the local command head (whitelist), and remote URLs (https / loopback only).
// Writes are atomic (temp + rename) with a .bak rollback, and only ever touch mcp[<name>].

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import type { ProviderInput } from "../shared/alpha-model-types"
import type { InstallMeta } from "../preload/types"
import { opencodeHomeDir } from "./alpha-bridge"
import { addReceipt, alphaGlobalRoot, removeReceipt } from "./alpha-installs"
import { alphaJsoncPath } from "./engine-config-truth"

export type ConfigResult = { ok: true } | { ok: false; reason: string }

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_MCP_FIELDS = new Set([
  "type",
  "command",
  "url",
  "environment",
  "headers",
  "disabled",
  "enabled",
  "cwd",
  "timeout",
  "oauth",
])
// Command heads we allow for local (stdio) MCP servers. Absolute paths under the standard mac
// package-manager bin dirs are also accepted (Homebrew / system).
const SAFE_COMMAND_HEADS = new Set(["uv", "uvx", "node", "npx", "bun", "bunx", "python", "python3", "git", "deno"])
const SAFE_ABS_PREFIXES = ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"]
// Inline-code flags: a whitelisted head + one of these = arbitrary code execution (`node -e …`,
// `python -c …`, `deno eval …`). Package runners (`npx -y <pkg>`, `uvx <pkg>`) never need them.
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "eval"])
// Loader/hook env vars that turn a benign command into code execution regardless of its args.
const DANGEROUS_ENV = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONSTARTUP",
  "BUN_INSPECT",
])

function userConfigDir(): string {
  // Mirror opencode's own resolution (core/global.ts): OPENCODE_CONFIG_DIR wins, else
  // XDG_CONFIG_HOME/opencode, else ~/.config/opencode. This also isolates writes under
  // OPENCODE_TEST_ONBOARDING (which redirects XDG_CONFIG_HOME to a temp dir) so test installs
  // never touch the user's real config.
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

function userConfigPath(): string {
  const dir = userConfigDir()
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc // default to .jsonc (preserves comments)
}

// REQ-018 T2:定制中心安装物(mcp/plugin)的引擎侧持久化改走 ~/.opencode/opencode.jsonc ——
// home `.opencode` 本就是引擎的 config 源(上游 config/paths.ts),且是**文件通道**:实例
// reload(instance.dispose → 重建)会重读它,免重启生效成立;env 注入(OPENCODE_CONFIG_CONTENT)
// 在 sidecar fork 时冻结,不能承载安装物。provider(BYOK 设置域)仍写共享 XDG 根,不迁。
function alphaOpencodeConfigPath(): string {
  const dir = opencodeHomeDir()
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

// REQ-059:alpha 写入的引擎配置唯一真源 = ~/.alpha/alpha.jsonc(经 sidecar G1 = OPENCODE_CONFIG
// 注入,引擎原生「额外配置文件」合并,dispose 重读;T0 spike audits/2026-07-07-req059-060-t0-spike)。
// 取代 REQ-018 的 ~/.opencode/opencode.jsonc(home walk 发现)。alpha 从此不写 .opencode。
// alphaJsoncPath 由 engine-config-truth 单一真源导出(sidecar 注入用同一路径)。

// mcp / plugin / 治理键 的写入目标。两级逃生:
//   ALPHA_JSONC_TRUTH_DISABLE=1 → 回 REQ-018 行为(~/.opencode/opencode.jsonc);
//   ALPHA_LEGACY_INSTALL_ROOT=1 → 回最旧行为(共享 XDG,不记账)。
function mcpPluginTargetPath(): string {
  if (process.env.ALPHA_LEGACY_INSTALL_ROOT === "1") return userConfigPath()
  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1") return alphaOpencodeConfigPath()
  return alphaJsoncPath()
}

// provider / BYOK 设置域的写入目标(REQ-059 §3:接管 XDG 写入域)。alpha 停写 XDG;逃生回 XDG。
function providerTargetPath(): string {
  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1" || process.env.ALPHA_LEGACY_INSTALL_ROOT === "1")
    return userConfigPath()
  return alphaJsoncPath()
}

// 迁移期:主目标之外仍可能残留 alpha 写入物的历史位置(去重、排除主目标)。REQ-018 mcp/plugin 写
// ~/.opencode、更早写 XDG;REQ-059 后 provider 从 XDG 迁 ~/.alpha。清除/读取都要覆盖这些兜底位置,
// 否则存量副本会在下次 reconnect「影子复活」已删条目、或漏读未迁尽的存量。
function legacyConfigPaths(primary: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([primary])
  for (const p of [alphaJsoncPath(), alphaOpencodeConfigPath(), userConfigPath()]) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

// provider 读取:真源优先 + 存量兜底(迁移期不漏读)。返回去重路径列表(主目标在首)。
function providerReadPaths(): string[] {
  return [providerTargetPath(), ...legacyConfigPaths(providerTargetPath())]
}

// ── REQ-037 治理层写入(叶子键事务)────────────────────────────────────────────
// 与 persistMcp 同一 home jsonc 目标 + 同一 jsonc-parser 修改姿势,但:①一次事务应用多个**叶子**
// 编辑(agent.<n>.hidden 而非整个 agent.<n> —— 用户同名兄弟字段保留,验收⑥);②独立的路径白名单
// (只允许治理面的三个受控域,与 MCP/plugin 白名单互不放宽);③value=undefined = 删除该叶子(净除)。
export type GovernanceEdit = { path: string[]; value: unknown; onlyIfAbsent?: boolean }

const GOV_NAME_RE = /^[a-zA-Z0-9*][a-zA-Z0-9._*-]{0,63}$/
function governancePathAllowed(p: string[]): boolean {
  if (p[0] === "agent")
    return p.length === 3 && GOV_NAME_RE.test(p[1]) &&
      ["hidden", "disable", "prompt", "model", "permission", "description", "temperature", "steps", "variant", "color"].includes(p[2])
  if (p[0] === "permission") return p.length === 3 && p[1] === "skill" && GOV_NAME_RE.test(p[2])
  if (p[0] === "command") return p.length === 3 && GOV_NAME_RE.test(p[1]) && ["template", "description", "agent", "model"].includes(p[2])
  return false
}

export type GovernanceApplyOutcome = { ok: true; applied: string[][] } | { ok: false; reason: string }

/** 一次事务应用全部治理叶子编辑:全部路径过白名单 → 逐条 modify → 解析校验 → 原子写(失败整体回滚)。
 *  返回**实际写入**的叶子路径(onlyIfAbsent 被跳过的不算 —— codex H1:跳过的键绝不能进记账,
 *  否则 reset 会删掉用户自有的同名键,如用户预设的 permission.skill."*")。 */
export function applyGovernanceEdits(edits: GovernanceEdit[]): GovernanceApplyOutcome {
  for (const e of edits) {
    if (!governancePathAllowed(e.path)) return { ok: false, reason: `refused: governance path not allowed: ${e.path.join(".")}` }
  }
  const target = mcpPluginTargetPath()
  const bak = `${target}.bak`
  const tmp = `${target}.tmp`
  let text = "{}"
  try {
    if (fs.existsSync(target)) text = fs.readFileSync(target, "utf8")
  } catch {
    return { ok: false, reason: "failed to read config" }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.writeFileSync(bak, text)
    const preParsed = (parse(text) as Record<string, unknown> | undefined) ?? {}
    const nodeAt = (obj: unknown, p: string[]): unknown => {
      let node: unknown = obj
      for (const seg of p) node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined
      return node
    }
    const applied: string[][] = []
    for (const e of edits) {
      if (e.onlyIfAbsent) {
        const existing = parse(text) as Record<string, unknown> | undefined
        if (nodeAt(existing, e.path) !== undefined) continue // 用户已有 → 跳过且不记账(codex H1)
      }
      const edits2 = modify(text, e.path, e.value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
      text = applyEdits(text, edits2)
      if (e.value !== undefined) applied.push(e.path)
    }
    // 空壳剪枝:叶子删除后留下的空父对象必须移除 —— `command.<n>: {}` 缺 template 会被引擎
    // schema 硬拒(整份配置作废,memory opencode-config-v1-schema);逐层(深→浅)清空对象。
    // codex L1:只剪「本事务把它删空」的父级 —— 事务前就为空的对象是用户自有占位,不动。
    const removalPaths = edits.filter((e) => e.value === undefined).map((e) => e.path)
    for (let depth = 2; depth >= 1; depth--) {
      for (const p of removalPaths) {
        const parentPath = p.slice(0, depth)
        const before = nodeAt(preParsed, parentPath)
        const wasNonEmpty = before && typeof before === "object" && !Array.isArray(before) && Object.keys(before as object).length > 0
        if (!wasNonEmpty) continue
        const parsed = parse(text) as Record<string, unknown> | undefined
        const node = nodeAt(parsed, parentPath)
        if (node && typeof node === "object" && !Array.isArray(node) && Object.keys(node as object).length === 0) {
          text = applyEdits(text, modify(text, parentPath, undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
        }
      }
    }
    const errors: ParseError[] = []
    parse(text, errors)
    if (errors.length > 0) throw new Error("resulting config is not valid jsonc")
    fs.writeFileSync(tmp, text, "utf8")
    fs.renameSync(tmp, target)
    if (fs.existsSync(bak)) {
      try {
        fs.unlinkSync(bak)
      } catch {
        /* best-effort cleanup */
      }
    }
    return { ok: true, applied }
  } catch (error) {
    try {
      if (fs.existsSync(bak)) fs.copyFileSync(bak, target)
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* nothing more we can do */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write config" }
  }
}

function receiptsActive(): boolean {
  return process.env.ALPHA_LEGACY_INSTALL_ROOT !== "1"
}

function validateServer(server: Record<string, unknown>): ConfigResult {
  for (const key of Object.keys(server)) {
    if (!SAFE_MCP_FIELDS.has(key)) return { ok: false, reason: `field not allowed: ${key}` }
  }
  const command = (server as { command?: unknown }).command
  if (Array.isArray(command) && command.length > 0) {
    const head = String(command[0])
    const base = path.basename(head)
    const allowed = SAFE_COMMAND_HEADS.has(base) || SAFE_ABS_PREFIXES.some((p) => head.startsWith(p))
    if (!allowed) return { ok: false, reason: `command not allowed: ${head}` }
    // A whitelisted head with arbitrary args is still config-time RCE — the command-head check alone
    // doesn't cover `node -e <payload>`. Reject inline-eval flags in the args (C2).
    for (const arg of command.slice(1)) {
      if (typeof arg !== "string") return { ok: false, reason: "command args must be strings" }
      if (EVAL_FLAGS.has(arg)) return { ok: false, reason: `command arg not allowed: ${arg}` }
    }
  }
  const url = (server as { url?: unknown }).url
  if (typeof url === "string") {
    // Parse with the WHATWG URL (not a substring prefix) so hosts like http://localhost.evil.com
    // or http://127.0.0.1@evil.com can't slip past the loopback allowlist. https is allowed for any
    // host (remote MCP); plain http only for loopback, and never with embedded credentials.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: "invalid url" }
    }
    const loopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
    const ok =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && loopback && !parsed.username && !parsed.password)
    if (!ok) return { ok: false, reason: "only https (or loopback http) URLs are allowed" }
  }
  // environment / headers were previously accepted by field-name only — their VALUES were unvalidated
  // (C2). Require string maps and block loader/hook env vars that achieve code execution.
  const environment = (server as { environment?: unknown }).environment
  if (environment !== undefined) {
    if (typeof environment !== "object" || environment === null || Array.isArray(environment))
      return { ok: false, reason: "environment must be an object" }
    for (const [k, v] of Object.entries(environment as Record<string, unknown>)) {
      if (DANGEROUS_ENV.has(k)) return { ok: false, reason: `env var not allowed: ${k}` }
      if (typeof v !== "string") return { ok: false, reason: `env value must be a string: ${k}` }
    }
  }
  const headers = (server as { headers?: unknown }).headers
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers))
      return { ok: false, reason: "headers must be an object" }
    for (const v of Object.values(headers as Record<string, unknown>)) {
      if (typeof v !== "string") return { ok: false, reason: "header values must be strings" }
    }
  }
  return { ok: true }
}

// Top-level keys we've verified against opencode's V1 schema (packages/core/src/v1/config/config.ts).
// opencode hard-fails its ENTIRE config on any unrecognized top-level key, so a single wrong key
// breaks every session — this allowlist makes such a regression fail loudly here instead.
const ALLOWED_TOP_KEYS = new Set(["mcp", "plugin", "provider"])

// https for any host; plain http only for loopback, never with embedded credentials. WHATWG-parsed
// (not substring) so http://localhost.evil.com / http://127.0.0.1@evil.com can't slip past.
function isAllowedUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback && !parsed.username && !parsed.password)
}

function writeKey(target: string, keyPath: string[], value: unknown): ConfigResult {
  if (!ALLOWED_TOP_KEYS.has(keyPath[0])) return { ok: false, reason: `refused: unknown config key "${keyPath[0]}"` }
  const bak = `${target}.bak`
  const tmp = `${target}.tmp`
  let text = "{}"
  try {
    if (fs.existsSync(target)) text = fs.readFileSync(target, "utf8")
  } catch {
    return { ok: false, reason: "failed to read config" }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.writeFileSync(bak, text)
    const edits = modify(text, keyPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    const result = applyEdits(text, edits)
    const errors: ParseError[] = []
    parse(result, errors)
    if (errors.length > 0) throw new Error("resulting config is not valid jsonc")
    fs.writeFileSync(tmp, result, "utf8")
    fs.renameSync(tmp, target)
    if (fs.existsSync(bak)) {
      try {
        fs.unlinkSync(bak)
      } catch {
        /* best-effort cleanup */
      }
    }
    return { ok: true }
  } catch (error) {
    // Roll back from the backup so a failed write never leaves a corrupt config.
    try {
      if (fs.existsSync(bak)) fs.copyFileSync(bak, target)
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* nothing more we can do */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write config" }
  }
}

/** Persist an MCP server under mcp[<name>] in the alpha-owned engine config file (durable) + receipt. */
export function persistMcp(name: string, server: Record<string, unknown>, meta?: InstallMeta): ConfigResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid server name" }
  if (!server || typeof server !== "object") return { ok: false, reason: "invalid server config" }
  const valid = validateServer(server)
  if (!valid.ok) return valid
  const written = writeKey(mcpPluginTargetPath(), ["mcp", name], server)
  if (written.ok && receiptsActive()) {
    addReceipt(alphaGlobalRoot(), {
      id: meta?.catalogId ?? `user:${name}`,
      name,
      type: "mcp",
      scope: "global",
      version: meta?.version,
      installedAt: new Date().toISOString(),
      origin: meta?.catalogId ? "catalog" : "created",
      configKey: `mcp.${name}`,
    })
  }
  return written
}

/**
 * Remove mcp[<name>] — from the alpha-owned file, and (pre-migration installs, T3) from the legacy
 * shared XDG config when it still carries the entry. Receipt goes too.
 */
export function removeMcp(name: string): ConfigResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid server name" }
  const primary = writeKey(mcpPluginTargetPath(), ["mcp", name], undefined)
  if (!primary.ok) return primary
  for (const legacy of legacyConfigPaths(mcpPluginTargetPath())) {
    try {
      if (!fs.existsSync(legacy)) continue
      const parsed = parse(fs.readFileSync(legacy, "utf8")) as { mcp?: Record<string, unknown> } | undefined
      if (parsed?.mcp && typeof parsed.mcp === "object" && name in parsed.mcp) {
        const legacyResult = writeKey(legacy, ["mcp", name], undefined)
        if (!legacyResult.ok) return legacyResult
      }
    } catch {
      /* unreadable legacy config → nothing to remove there */
    }
  }
  if (receiptsActive()) removeReceipt(alphaGlobalRoot(), "mcp", name)
  return { ok: true }
}

/**
 * Persist a custom provider under provider[<id>] in the user's opencode config (durable). NOTE: the
 * id must ALSO be merged into the injected enabled_providers allowlist at sidecar start
 * (alpha-models.ts → readUserProviderIds) — opencode replaces (doesn't union) the enabled_providers
 * array on merge, so a provider not in the injected allowlist is dropped (see build.md §6). The user
 * therefore sees a new custom provider after the next reconnect, not instantly.
 */
export function persistProvider(input: ProviderInput): ConfigResult {
  if (!SAFE_NAME.test(input.id)) return { ok: false, reason: "invalid provider id" }
  if (!input.name || typeof input.name !== "string") return { ok: false, reason: "missing provider name" }
  if (input.compat !== "openai" && input.compat !== "anthropic") return { ok: false, reason: "invalid compat" }
  if (!isAllowedUrl(input.baseURL)) return { ok: false, reason: "only https (or loopback http) base URLs are allowed" }
  if (!input.apiKey || typeof input.apiKey !== "string") return { ok: false, reason: "missing api key" }
  const ids = (Array.isArray(input.models) ? input.models : []).map((m) => String(m).trim()).filter(Boolean)
  if (ids.length === 0) return { ok: false, reason: "at least one model id is required" }
  const npm = input.compat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
  const models: Record<string, { name: string }> = {}
  for (const m of ids) models[m] = { name: m }
  const block = { npm, name: input.name, options: { baseURL: input.baseURL, apiKey: input.apiKey }, models }
  return writeKey(providerTargetPath(), ["provider", input.id], block)
}

/**
 * Provider ids the user has configured in opencode.jsonc. Merged into the injected enabled_providers
 * allowlist (alpha-models.ts) so user-added custom providers survive the hard allowlist (build.md §6).
 */
export function readUserProviderIds(): string[] {
  const ids = new Set<string>()
  for (const target of providerReadPaths()) {
    try {
      if (!fs.existsSync(target)) continue
      const parsed = parse(fs.readFileSync(target, "utf8")) as { provider?: unknown } | undefined
      const prov = parsed?.provider
      if (prov && typeof prov === "object") for (const id of Object.keys(prov as Record<string, unknown>)) ids.add(id)
    } catch {
      /* unreadable → skip this source */
    }
  }
  return [...ids]
}

/**
 * Provider ids in opencode.jsonc that carry an INLINE api key (provider[id].options.apiKey). The
 * model picker uses this (plus the keyEnv env check) to show "已配置 / 需配置" state — builtin
 * providers are injected as config-only, so without this they look identical whether keyed or not.
 */
export function readConfiguredProviderKeys(): Map<string, string> {
  const out = new Map<string, string>()
  // Real source first; existing sources only fill ids not already seen (migration-period fallback).
  for (const target of providerReadPaths()) {
    try {
      if (!fs.existsSync(target)) continue
      const parsed = parse(fs.readFileSync(target, "utf8")) as { provider?: Record<string, unknown> } | undefined
      const prov = parsed?.provider
      if (prov && typeof prov === "object") {
        for (const [id, def] of Object.entries(prov)) {
          if (out.has(id)) continue
          const key = (def as { options?: { apiKey?: unknown } } | null)?.options?.apiKey
          if (typeof key === "string" && key.trim().length > 0) out.set(id, key)
        }
      }
    } catch {
      /* unreadable config → skip this source */
    }
  }
  return out
}

/**
 * Remove a custom provider block (definition + inline key) from opencode.jsonc. For a builtin alpha
 * re-injects the definition at fork, so this just drops a user-set inline key; for an off-catalog
 * custom provider it removes it entirely. BYOK keys now live in alpha's keychain (alpha-byok-keys),
 * removed separately via providers.removeKey. Env keys (alpha.env) are untouched. Next reconnect.
 */
export function removeProvider(id: string): ConfigResult {
  if (!SAFE_NAME.test(id)) return { ok: false, reason: "invalid provider id" }
  // Drop from the real source, and from any legacy source (XDG/~/.opencode) still carrying it during
  // the migration period — otherwise a stale copy would shadow-resurrect the provider on next reconnect.
  const primary = writeKey(providerTargetPath(), ["provider", id], undefined)
  if (!primary.ok) return primary
  for (const legacy of providerReadPaths().slice(1)) {
    try {
      if (!fs.existsSync(legacy)) continue
      const parsed = parse(fs.readFileSync(legacy, "utf8")) as { provider?: Record<string, unknown> } | undefined
      if (parsed?.provider && typeof parsed.provider === "object" && id in parsed.provider) {
        const r = writeKey(legacy, ["provider", id], undefined)
        if (!r.ok) return r
      }
    } catch {
      /* unreadable legacy → nothing to remove there */
    }
  }
  return { ok: true }
}

// npm package name (optional scope), optionally pinned with @version. No shell metacharacters —
// opencode installs the package itself on next launch (loader.ts resolvePluginTarget), so we never
// shell out; this only gates what we write into the config.
const SAFE_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9.+~^*<>=|-]*)?$/i

// Strip a trailing @version while preserving a leading @scope (so "@a/b@1" → "@a/b", "b@1" → "b").
function pkgBase(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Append a plugin package to the config `plugin` array (SINGULAR — the key opencode's V1 schema
 * accepts; `plugins` would hard-fail the whole config). opencode auto-installs it from npm on next
 * launch. Idempotent; the caller should prompt for a restart (config is read at boot only).
 */
export function persistPlugin(pkg: string, meta?: InstallMeta): ConfigResult {
  if (!SAFE_PACKAGE.test(pkg)) return { ok: false, reason: "invalid package name" }
  const target = mcpPluginTargetPath()
  const readPlugins = (file: string): unknown[] => {
    try {
      if (!fs.existsSync(file)) return []
      const parsed = parse(fs.readFileSync(file, "utf8")) as { plugin?: unknown } | undefined
      return Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : []
    } catch {
      return []
    }
  }
  // opencode validates opencode.jsonc with its V1 schema, whose key is `plugin` (SINGULAR) —
  // `plugins` is an unrecognized key and makes opencode hard-fail the ENTIRE config (breaking every
  // session), see packages/core/src/v1/config/config.ts:56. Element shape is string | [string, opts].
  const current = readPlugins(target)
  const base = pkgBase(pkg)
  const inList = (list: unknown[]) =>
    list.some((p) => {
      if (typeof p === "string") return pkgBase(p) === base
      if (Array.isArray(p) && typeof p[0] === "string") return pkgBase(p[0]) === base
      return false
    })
  // idempotent across BOTH files: an entry still sitting in the legacy XDG config (pre-migration)
  // must not be duplicated into the alpha file — the engine merges the two plugin arrays.
  if (inList(current) || (target !== userConfigPath() && inList(readPlugins(userConfigPath()))))
    return { ok: true }
  const written = writeKey(target, ["plugin"], [...current, pkg])
  if (written.ok && receiptsActive()) {
    addReceipt(alphaGlobalRoot(), {
      id: meta?.catalogId ?? `user:${pkgBase(pkg)}`,
      name: pkgBase(pkg).replace(/^@/, "").replace("/", "__"),
      type: "plugin",
      scope: "global",
      version: meta?.version,
      installedAt: new Date().toISOString(),
      origin: meta?.catalogId ? "catalog" : "created",
      configKey: `plugin:${pkg}`,
    })
  }
  return written
}

/**
 * Remove a plugin package from config `plugin[]` (alpha-owned file + legacy XDG file, pre-migration)
 * and drop its receipt. Idempotent — absent package is a no-op success.
 */
export function removePlugin(pkg: string): ConfigResult {
  if (!SAFE_PACKAGE.test(pkg)) return { ok: false, reason: "invalid package name" }
  const base = pkgBase(pkg)
  const dropFrom = (file: string): ConfigResult => {
    let text = "{}"
    try {
      if (!fs.existsSync(file)) return { ok: true }
      text = fs.readFileSync(file, "utf8")
    } catch {
      return { ok: false, reason: "failed to read config" }
    }
    const parsed = parse(text) as { plugin?: unknown } | undefined
    const current: unknown[] = Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : []
    const next = current.filter((p) => {
      if (typeof p === "string") return pkgBase(p) !== base
      if (Array.isArray(p) && typeof p[0] === "string") return pkgBase(p[0]) !== base
      return true
    })
    if (next.length === current.length) return { ok: true } // not present here
    return writeKey(file, ["plugin"], next)
  }
  const primary = dropFrom(mcpPluginTargetPath())
  if (!primary.ok) return primary
  for (const legacy of legacyConfigPaths(mcpPluginTargetPath())) {
    const r = dropFrom(legacy)
    if (!r.ok) return r
  }
  if (receiptsActive()) removeReceipt(alphaGlobalRoot(), "plugin", base.replace(/^@/, "").replace("/", "__"))
  return { ok: true }
}

// ── REQ-023 T2:vendored 插件的绝对路径持久化(零网络通道) ──────────────────────────────────
// 引擎 plugin[] 原生接受绝对路径(config/plugin.ts:42-60,与 @alpha-code/ext 注入同机制)。
// 路径必须位于 ~/.alpha/plugins 树内(装载面收敛:不能把任意本机 JS 喂进引擎进程)。

function underAlphaPlugins(absPath: string): boolean {
  const root = path.join(alphaGlobalRoot(), "plugins")
  const resolved = path.resolve(absPath)
  return resolved.startsWith(root + path.sep)
}

export function persistPluginPath(name: string, absJsPath: string, files: string[], meta?: InstallMeta): ConfigResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return { ok: false, reason: "invalid plugin name" }
  if (!path.isAbsolute(absJsPath) || !absJsPath.endsWith(".js") || !underAlphaPlugins(absJsPath))
    return { ok: false, reason: "refused: plugin path outside ~/.alpha/plugins" }
  const target = mcpPluginTargetPath()
  const read = (): unknown[] => {
    try {
      if (!fs.existsSync(target)) return []
      const parsed = parse(fs.readFileSync(target, "utf8")) as { plugin?: unknown } | undefined
      return Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : []
    } catch {
      return []
    }
  }
  const current = read()
  if (current.some((p) => p === absJsPath)) return { ok: true } // idempotent
  const written = writeKey(target, ["plugin"], [...current, absJsPath])
  if (written.ok && receiptsActive()) {
    addReceipt(alphaGlobalRoot(), {
      id: meta?.catalogId ?? `user:${name}`,
      name,
      type: "plugin",
      scope: "global",
      version: meta?.version,
      installedAt: new Date().toISOString(),
      origin: meta?.catalogId ? "catalog" : "imported",
      configKey: `plugin-path:${absJsPath}`,
      files,
    })
  }
  return written
}

export function removePluginPath(name: string, absJsPath: string): ConfigResult {
  if (!path.isAbsolute(absJsPath)) return { ok: false, reason: "invalid plugin path" }
  const target = mcpPluginTargetPath()
  try {
    if (fs.existsSync(target)) {
      const parsed = parse(fs.readFileSync(target, "utf8")) as { plugin?: unknown } | undefined
      const current: unknown[] = Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : []
      const next = current.filter((p) => p !== absJsPath)
      if (next.length !== current.length) {
        const written = writeKey(target, ["plugin"], next)
        if (!written.ok) return written
      }
    }
  } catch {
    return { ok: false, reason: "failed to read config" }
  }
  if (receiptsActive()) removeReceipt(alphaGlobalRoot(), "plugin", name)
  return { ok: true }
}

// ── B11/B23:全局配置健康探测 ─────────────────────────────────────────────────────────────────
// 上游行为(不可改,ADR-005):opencode 对全局 opencode.jsonc 的 jsonc 语法错误或**任何未识别
// 顶层 key** 都会让 loadGlobal 失败 → 整份配置被静默清零为 {}(config.ts:281-289,parse.ts
// unrecognized_keys)。这里在 main 侧用同一份文件做前置探测,给 renderer 一个显式告警入口。
//
// 顶键集提取自引擎真 schema `packages/core/src/v1/config/config.ts` Info Struct(2026-07-04);
// 上游新增顶键会造成误报(banner 多报,不吞真错)→ upstream sync 后如误报,重新提取此表即可;
// 逃生:ALPHA_CONFIG_HEALTH_DISABLE=1。
const V1_TOP_KEYS = new Set([
  "$schema", "shell", "logLevel", "server", "command", "skills", "references", "reference",
  "watcher", "snapshot", "plugin", "share", "autoshare", "autoupdate", "disabled_providers",
  "enabled_providers", "model", "small_model", "default_agent", "username", "mode", "agent",
  "provider", "mcp", "formatter", "lsp", "instructions", "layout", "permission", "tools",
  "attachment", "enterprise", "tool_output", "compaction", "experimental",
])

export type ConfigHealth = { broken: boolean; reason?: string; path?: string }

export function configHealth(): ConfigHealth {
  if (process.env.ALPHA_CONFIG_HEALTH_DISABLE === "1") return { broken: false }
  const file = userConfigPath()
  let text: string
  try {
    if (!fs.existsSync(file)) return { broken: false, path: file }
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { broken: false, path: file }
  }
  if (!text.trim()) return { broken: false, path: file }
  const errors: ParseError[] = []
  const obj = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { broken: true, reason: "配置文件存在语法错误,引擎会忽略整份配置", path: file }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const unknown = Object.keys(obj).filter((k) => !V1_TOP_KEYS.has(k))
    if (unknown.length > 0) {
      return {
        broken: true,
        reason: `存在无法识别的配置项(${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}),引擎会忽略整份配置`,
        path: file,
      }
    }
  }
  return { broken: false, path: file }
}
