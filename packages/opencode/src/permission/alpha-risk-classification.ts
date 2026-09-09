// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-158 / #1285 —— 授权提示的**规则式**风险分类。
//
// 它回答一个问题:「弹到用户面前的这一问,按已知事实属于哪一类、有多危险」。它只产生**信息**
// (写进 v1 Request 的 `metadata.alphaRisk`),不产生任何否决/放行通道 —— `Permission.ask` 的
// `evaluate()` 判定在它之前完成且不读它(`#1291` 决定书 §2.2:分类是输入、cap 是上限、审批是待裁决态)。
//
// ── 分类法(只借 openai/codex guardian policy 的**分类法**,不借它的模型评分)────────────────
// 本机实读 `codex-cli 0.144.1` 二进制里内嵌的 guardian 策略文本
// (`/opt/homebrew/lib/node_modules/@openai/codex/…/bin/codex`,`strings` 抽取),借四条:
//   · 档位词表 `low` / `medium` / `high` / `critical`,`critical` = 「明显的凭据/秘密外发到不受信目的地,
//     或重大不可逆破坏」;
//   · Data Exfiltration:把私有数据/秘密发到**受信目的地之外** ⇒ high/critical;「授权创建 ≠ 授权外发」;
//     目的地不在受信清单上、且载荷可能含私有数据 ⇒ high;
//   · Credential Probing:从**非常规来源**取凭据(浏览器 profile、钥匙串导出、`~/.ssh` 等)⇒ high;
//   · Persistent Security Weakening / Destructive:持久化削弱安全设置、不可逆破坏 ⇒ high/critical;
//     「路径在工作区之外」**本身不构成** high(codex 原文:benign local filesystem actions are usually low)。
// 不借:`user_authorization` 评分、任何 LLM 复审、异步打分。本模块是纯函数、零 IO、零 provider import
// (AC3 的源码级判据在 `test/permission/alpha-risk-classification.test.ts`)。
//
// ── 事实从哪来(不手写别人的文法)────────────────────────────────────────────────────────
// · 能力轴那一问(工具体内 `ctx.ask`):`permission` / `patterns` / `always` / `metadata` 全是上游工具
//   **已经派生好的事实** —— edit/read 的 `patterns` 是 `path.relative(worktree, …)`(相对形态即「在不在
//   工作区内」的答案),bash 的 `patterns` 是 tree-sitter 按命令切好的原文、`always` 是 `BashArity.prefix`
//   算出的命令头(程序名从这里取,不自己 tokenize),webfetch 的 `patterns[0]` 是完整 URL(交给平台的
//   `URL` 解析,不自己拆)。
// · 身份轴那一问(`gateToolExecution`):`metadata.identity` / `authority` / `transport` / `args` 由
//   `alpha-tool-policy-gate.ts` 供数(#1285 的供数缺口就在这里补:远端 MCP 的目的地 = transport.url,
//   载荷 = args 的字符串叶子)。
// · 词法探针(凭据路径、秘密形状的 token、URL 抽取)一律 **raise-only**:命中只能抬高档位,未命中不降档。
//   它们不声称理解 shell 文法 —— 这正是「不解析 shell 找目的地」纪律与「别把未知放行」之间的折中。
//
// ── 兜底(AC2)────────────────────────────────────────────────────────────────────────────
// 没有任何规则命中 ⇒ `kind: "unknown"`,`level: "critical"`(最保守档),`rules: ["fallback:unknown"]`。
// 分类器抛异常同样落到这一档(`fallback:classifier-threw`)—— 一次分类失败不能变成一次少问,也不能
// 变成一个 defect 让整条工具回合 die。
import type { ToolIdentity } from "@opencode-ai/schema/tool-identity"

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

/** AC2:未被任何规则覆盖的动作落在这一档。 */
export const MOST_CONSERVATIVE_LEVEL: RiskLevel = "critical"

export const RISK_KINDS = [
  "workspace-read",
  "workspace-write",
  "external-path",
  "network-read",
  "network-egress",
  "exfiltration",
  "credential-probing",
  "security-weakening",
  "destructive",
  "shell",
  "third-party-tool",
  "delegation",
  "session-internal",
  "unknown",
] as const
export type RiskKind = (typeof RISK_KINDS)[number]

/** v1 Request `metadata` 里承载分类结论的键。分类器**无条件覆盖**入参里的同名键(工具/MCP 伪造不了低档)。 */
export const RISK_METADATA_KEY = "alphaRisk"

export interface RiskFacts {
  /** 观察到的目的地(完整 URL 或 transport 的 URL)。 */
  readonly destinations: readonly string[]
  /** 观察到的路径 / 路径片段(含探针命中的片段)。 */
  readonly paths: readonly string[]
  /** shell 程序名(能力轴取自上游 `always` 的命令头;身份轴取自词法探针)。 */
  readonly programs: readonly string[]
  /** 探针信号名(`credential-path` / `secret-shaped` / `url-credentials` / `persistence-path` / …)。 */
  readonly signals: readonly string[]
}

export interface RiskClassification {
  readonly version: 1
  readonly level: RiskLevel
  readonly kind: RiskKind
  /** 命中的规则 id(有序;兜底时恰为 `["fallback:…"]`)。 */
  readonly rules: readonly string[]
  readonly facts: RiskFacts
}

/** 身份轴供数的传输事实(gate 从 MCP binding 派生;**去秘密**:不含 headers / env / oauth)。 */
export type ToolTransportFact =
  | { readonly kind: "mcp-remote"; readonly url: string }
  | { readonly kind: "mcp-local"; readonly command: readonly string[] }

export interface ClassifyInput {
  readonly permission: string
  readonly patterns: readonly string[]
  readonly always?: readonly string[]
  readonly metadata: Record<string, unknown>
}

// ── 档位序 ─────────────────────────────────────────────────────────────────────
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  return LEVEL_RANK[a] - LEVEL_RANK[b]
}

interface Verdict {
  readonly rule: string
  readonly level: RiskLevel
  readonly kind: RiskKind
}

interface Facts {
  destinations: Set<string>
  paths: Set<string>
  programs: Set<string>
  signals: Set<string>
}

const facts = (): Facts => ({ destinations: new Set(), paths: new Set(), programs: new Set(), signals: new Set() })

// ── 输入上限(探针是线性正则,但输入不该无界)──────────────────────────────────
const TEXT_PROBE_LIMIT = 200_000
const LEAF_LIMIT = 512

function clip(text: string): string {
  return text.length > TEXT_PROBE_LIMIT ? text.slice(0, TEXT_PROBE_LIMIT) : text
}

/** 递归收集字符串叶子(args / workflow tools 的载荷)。有界。 */
function stringLeaves(value: unknown, out: string[] = [], seen = new Set<object>()): string[] {
  if (out.length >= LEAF_LIMIT) return out
  if (typeof value === "string") {
    out.push(value)
    return out
  }
  if (typeof value !== "object" || value === null) return out
  if (seen.has(value)) return out
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, seen)
    return out
  }
  for (const item of Object.values(value as Record<string, unknown>)) stringLeaves(item, out, seen)
  return out
}

// ── 词法探针(raise-only)────────────────────────────────────────────────────────
/** 凭据所在的**非常规来源**(codex「Credential Probing」的来源定义 + 本机常见落点)。 */
const CREDENTIAL_PATH_PROBES: readonly RegExp[] = [
  /(^|[\s"'`=:/])\.ssh(?=[/\s"'`]|$)/,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/,
  /\.aws[\\/](?:credentials|config)\b/,
  /(^|[\s"'`=:/])\.(?:netrc|npmrc|pypirc|git-credentials)\b/,
  /\.docker[\\/]config\.json\b/,
  /\.kube[\\/]config\b/,
  /(^|[\s"'`=:/])\.gnupg(?=[/\s"'`]|$)/,
  /(^|[\s"'`=:/])\.env(?:\.[\w-]+)?(?=$|[\s"'`;|&)])/,
  /\/etc\/(?:passwd|shadow|sudoers)\b/,
  /Library[\\/]Keychains\b|\.keychain(?:-db)?\b/,
  /\bcredentials\.json\b/,
  /\bsecrets?\.(?:json|ya?ml|toml|env)\b/,
  /\.(?:pem|p12|pfx)\b/,
  /(?:Chrome|Chromium|Brave|Edge|Firefox)[^\n]{0,80}?(?:Cookies|Login Data|cookies\.sqlite|logins\.json)\b/,
]

/** 持久化削弱安全设置的落点(写入这些路径 = codex「Persistent Security Weakening」)。 */
const PERSISTENCE_PATH_PROBES: readonly RegExp[] = [
  /\bauthorized_keys\b/,
  /\/etc\/(?:sudoers|hosts|profile|crontab)\b/,
  /(^|[\s"'`=:/])\.(?:bashrc|zshrc|profile|zprofile|bash_profile|zshenv|gitconfig)\b/,
  /\.git[\\/]hooks[\\/]/,
  /Library[\\/]Launch(?:Agents|Daemons)\b/,
  /\bcrontab\b/,
]

/** 秘密形状的 token(与仓内 tool-card redactor 同族的保守集合;命中只抬档)。 */
const SECRET_SHAPED_PROBES: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|secret|passw(?:or)?d|token|authorization)\s*[=:]\s*["']?[^\s"']{8,}/i,
]

const URL_IN_TEXT = /\b(?:https?|wss?|s?ftp):\/\/[^\s"'<>)\]]+/gi

function anyMatch(probes: readonly RegExp[], text: string): string | undefined {
  for (const probe of probes) {
    const match = probe.exec(text)
    if (match) return match[0]
  }
  return undefined
}

function probeCredentialPath(text: string, f: Facts): boolean {
  const hit = anyMatch(CREDENTIAL_PATH_PROBES, clip(text))
  if (hit === undefined) return false
  f.signals.add("credential-path")
  f.paths.add(hit.trim())
  return true
}

function probePersistencePath(text: string, f: Facts): boolean {
  const hit = anyMatch(PERSISTENCE_PATH_PROBES, clip(text))
  if (hit === undefined) return false
  f.signals.add("persistence-path")
  f.paths.add(hit.trim())
  return true
}

function probeSecretShaped(text: string, f: Facts): boolean {
  const hit = anyMatch(SECRET_SHAPED_PROBES, clip(text))
  if (hit === undefined) return false
  f.signals.add("secret-shaped")
  return true
}

function collectUrls(text: string, f: Facts): number {
  let count = 0
  const clipped = clip(text)
  URL_IN_TEXT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_IN_TEXT.exec(clipped))) {
    const raw = match[0].replace(/[.,;:]+$/, "")
    if (URL.canParse(raw)) {
      f.destinations.add(new URL(raw).href)
      count += 1
    }
  }
  return count
}

// ── 路径形态(消费上游 `path.relative` 的结果,不自己判工作区)────────────────────
function outsideWorkspace(pattern: string): boolean {
  if (/^(?:\.\.)(?:[\\/]|$)/.test(pattern)) return true
  if (/^[\\/]/.test(pattern)) return true
  if (/^[A-Za-z]:[\\/]/.test(pattern)) return true
  if (/^~(?:[\\/]|$)/.test(pattern)) return true
  return false
}

// ── shell 程序表(键 = 上游 arity 命令头;先比两 token,再比一 token)────────────
const EGRESS_PROGRAMS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
  "git push",
  "gh api",
  "gh pr",
  "gh release",
  "gh gist",
  "gh repo",
  "gh issue",
  "npm publish",
  "bun publish",
  "pnpm publish",
  "yarn publish",
  "cargo publish",
  "twine",
  "docker push",
  "aws",
  "az",
  "gcloud",
  "gsutil",
  "s3cmd",
  "rclone",
  "wrangler",
  "vercel",
  "netlify",
  "heroku",
  "flyctl",
  "fly",
  "firebase",
  "kubectl",
  "helm",
  "terraform",
  "ansible",
  "ansible-playbook",
  "mail",
  "sendmail",
])
const DESTRUCTIVE_HIGH_PROGRAMS = new Set(["rm", "rmdir", "shred", "dd", "mkfs", "wipefs", "diskutil", "git filter-branch", "dropdb"])
const DESTRUCTIVE_MEDIUM_PROGRAMS = new Set([
  "git reset",
  "git clean",
  "git branch",
  "git rebase",
  "truncate",
  "kill",
  "killall",
  "pkill",
])
const PRIVILEGE_HIGH_PROGRAMS = new Set(["sudo", "su", "doas", "visudo", "csrutil", "spctl"])
const WEAKENING_MEDIUM_PROGRAMS = new Set([
  "chmod",
  "chown",
  "chgrp",
  "launchctl",
  "systemctl",
  "crontab",
  "defaults",
  "git config",
  "npm config",
  "ssh-keygen",
  "ssh-add",
])
const CREDENTIAL_PROGRAMS = new Set(["security", "gh auth", "op"])
const ENV_DUMP_PROGRAMS = new Set(["env", "printenv"])

const ALL_PROGRAM_KEYS = [
  ...EGRESS_PROGRAMS,
  ...DESTRUCTIVE_HIGH_PROGRAMS,
  ...DESTRUCTIVE_MEDIUM_PROGRAMS,
  ...PRIVILEGE_HIGH_PROGRAMS,
  ...WEAKENING_MEDIUM_PROGRAMS,
  ...CREDENTIAL_PROGRAMS,
  ...ENV_DUMP_PROGRAMS,
]

/** 从上游 `always` 的命令头(`"curl *"` / `"git push *"`)取程序键。 */
function programKeysFromPrefixes(always: readonly string[]): string[] {
  const keys: string[] = []
  for (const entry of always) {
    const tokens = entry.replace(/\s\*$/, "").trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || tokens[0] === "*") continue
    const one = tokens[0]!.replace(/^.*[\\/]/, "")
    const two = tokens.length > 1 ? `${one} ${tokens[1]}` : undefined
    if (two !== undefined && ALL_PROGRAM_KEYS.includes(two)) keys.push(two)
    else keys.push(one)
  }
  return keys
}

/**
 * 身份轴 bash(只有 `args.command`,没有上游切好的命令头)的词法回退:在命令起始位
 * (行首 / `;` `&&` `||` `|` 之后,可带 `sudo`)找表内程序名。raise-only。
 */
function programKeysLexical(command: string): string[] {
  const keys = new Set<string>()
  const text = clip(command)
  for (const key of ALL_PROGRAM_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")
    const probe = new RegExp(`(?:^|[;&|(]\\s*|\\bsudo\\s+)(?:[\\w./-]*[\\\\/])?${escaped}(?=\\s|$)`, "m")
    if (probe.test(text)) keys.add(key)
  }
  return [...keys]
}

function shellVerdicts(commandText: string, programKeys: readonly string[], f: Facts): Verdict[] {
  const out: Verdict[] = []
  for (const key of programKeys) f.programs.add(key)
  collectUrls(commandText, f)
  const egress = programKeys.some((key) => EGRESS_PROGRAMS.has(key))
  const credentialPath = probeCredentialPath(commandText, f)
  const secret = probeSecretShaped(commandText, f)
  const persistence = probePersistencePath(commandText, f)

  if (egress) {
    out.push({ rule: "bash.egress-program", level: "high", kind: "network-egress" })
    if (credentialPath) out.push({ rule: "bash.egress+credential-path", level: "critical", kind: "exfiltration" })
    if (secret) out.push({ rule: "bash.egress+secret-shaped", level: "critical", kind: "exfiltration" })
  } else {
    if (credentialPath) out.push({ rule: "bash.credential-path", level: "high", kind: "credential-probing" })
    if (secret) out.push({ rule: "bash.secret-literal", level: "medium", kind: "security-weakening" })
  }
  if (persistence) out.push({ rule: "bash.persistence-path", level: "high", kind: "security-weakening" })
  for (const key of programKeys) {
    if (DESTRUCTIVE_HIGH_PROGRAMS.has(key)) out.push({ rule: `bash.destructive:${key}`, level: "high", kind: "destructive" })
    else if (DESTRUCTIVE_MEDIUM_PROGRAMS.has(key))
      out.push({ rule: `bash.destructive:${key}`, level: "medium", kind: "destructive" })
    else if (PRIVILEGE_HIGH_PROGRAMS.has(key))
      out.push({ rule: `bash.privilege:${key}`, level: "high", kind: "security-weakening" })
    else if (WEAKENING_MEDIUM_PROGRAMS.has(key))
      out.push({ rule: `bash.weakening:${key}`, level: "medium", kind: "security-weakening" })
    else if (CREDENTIAL_PROGRAMS.has(key))
      out.push({ rule: `bash.credential-program:${key}`, level: "high", kind: "credential-probing" })
    else if (ENV_DUMP_PROGRAMS.has(key))
      out.push({ rule: `bash.env-dump:${key}`, level: "medium", kind: "credential-probing" })
  }
  // shell 本身是不透明的:没命中任何表也**不低于** medium(这是显式规则,不是兜底)。
  out.push({ rule: "bash.opaque", level: "medium", kind: "shell" })
  return out
}

// ── 能力轴各 permission 的规则 ────────────────────────────────────────────────────
function pathVerdicts(
  paths: readonly string[],
  f: Facts,
  mode: "read" | "write",
): Verdict[] {
  const out: Verdict[] = []
  for (const p of paths) f.paths.add(p)
  const joined = paths.join("\n")
  const outside = paths.some(outsideWorkspace)
  const credential = probeCredentialPath(joined, f)
  const persistence = mode === "write" && probePersistencePath(joined, f)
  if (mode === "write") {
    if (credential) out.push({ rule: "edit.credential-path", level: "high", kind: "security-weakening" })
    if (persistence) out.push({ rule: "edit.persistence-path", level: "high", kind: "security-weakening" })
    if (outside) out.push({ rule: "edit.outside-workspace", level: "medium", kind: "external-path" })
    out.push({ rule: "edit.workspace-path", level: "low", kind: "workspace-write" })
  } else {
    if (credential) out.push({ rule: "read.credential-path", level: "high", kind: "credential-probing" })
    if (outside) out.push({ rule: "read.outside-workspace", level: "medium", kind: "external-path" })
    out.push({ rule: "read.workspace-path", level: "low", kind: "workspace-read" })
  }
  return out
}

function urlVerdicts(raw: string, f: Facts, prefix: string): Verdict[] {
  const out: Verdict[] = []
  if (!URL.canParse(raw)) {
    out.push({ rule: `${prefix}.unparsable-url`, level: MOST_CONSERVATIVE_LEVEL, kind: "unknown" })
    return out
  }
  const url = new URL(raw)
  f.destinations.add(url.href)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    out.push({ rule: `${prefix}.non-http-scheme`, level: "high", kind: "network-read" })
  }
  if (url.username || url.password) {
    f.signals.add("url-credentials")
    out.push({ rule: `${prefix}.url-credentials`, level: "high", kind: "exfiltration" })
  }
  const tail = `${url.search}${url.hash}`
  if (tail && probeSecretShaped(tail, f)) {
    out.push({ rule: `${prefix}.secret-in-query`, level: "high", kind: "exfiltration" })
  }
  out.push({ rule: `${prefix}.destination`, level: "medium", kind: "network-read" })
  return out
}

function abilityVerdicts(input: ClassifyInput, f: Facts): Verdict[] {
  const md = input.metadata
  switch (input.permission) {
    case "edit":
      return pathVerdicts(input.patterns, f, "write")
    case "read": {
      if (input.patterns.some((p) => p.startsWith("mcp:"))) {
        for (const p of input.patterns) f.paths.add(p)
        return [{ rule: "read.mcp-resource", level: "medium", kind: "third-party-tool" }]
      }
      return pathVerdicts(input.patterns, f, "read")
    }
    case "external_directory": {
      const out: Verdict[] = []
      const dirs = [
        ...input.patterns,
        ...(typeof md["filepath"] === "string" ? [md["filepath"]] : []),
        ...(Array.isArray(md["directories"]) ? md["directories"].filter((d): d is string => typeof d === "string") : []),
      ]
      for (const d of dirs) f.paths.add(d)
      if (probeCredentialPath(dirs.join("\n"), f))
        out.push({ rule: "external_directory.credential-path", level: "high", kind: "credential-probing" })
      out.push({ rule: "external_directory.outside-workspace", level: "medium", kind: "external-path" })
      return out
    }
    case "bash": {
      const command = typeof md["command"] === "string" ? md["command"] : input.patterns.join("\n")
      const keys = input.always && input.always.length > 0 ? programKeysFromPrefixes(input.always) : programKeysLexical(command)
      return shellVerdicts(command, keys, f)
    }
    case "webfetch": {
      const url = typeof md["url"] === "string" ? md["url"] : input.patterns[0]
      if (url === undefined) return []
      return urlVerdicts(url, f, "webfetch")
    }
    case "websearch": {
      const query = typeof md["query"] === "string" ? md["query"] : input.patterns.join(" ")
      const out: Verdict[] = []
      if (probeSecretShaped(query, f)) out.push({ rule: "websearch.secret-in-query", level: "high", kind: "exfiltration" })
      out.push({ rule: "websearch.query", level: "medium", kind: "network-read" })
      return out
    }
    case "glob":
    case "grep": {
      const out: Verdict[] = []
      const path = typeof md["path"] === "string" ? md["path"] : undefined
      const pattern = typeof md["pattern"] === "string" ? md["pattern"] : input.patterns[0]
      if (path !== undefined) f.paths.add(path)
      if (path !== undefined && probeCredentialPath(path, f))
        out.push({ rule: `${input.permission}.credential-path`, level: "high", kind: "credential-probing" })
      if (input.permission === "grep" && pattern !== undefined && probeSecretShaped(pattern, f))
        out.push({ rule: "grep.secret-shaped-pattern", level: "medium", kind: "credential-probing" })
      out.push({ rule: `${input.permission}.workspace-search`, level: "low", kind: "workspace-read" })
      return out
    }
    case "lsp":
      return [{ rule: "lsp.workspace", level: "low", kind: "workspace-read" }]
    case "skill":
      return [{ rule: "skill.load", level: "low", kind: "workspace-read" }]
    case "todowrite":
      return [{ rule: "todowrite.session", level: "low", kind: "session-internal" }]
    case "task":
      return [{ rule: "task.subagent", level: "medium", kind: "delegation" }]
    case "doom_loop":
      return [{ rule: "doom_loop.repeat", level: "medium", kind: "session-internal" }]
    case "workflow_tool_approval": {
      const out: Verdict[] = []
      const leaves = stringLeaves(md["tools"])
      const text = leaves.join("\n")
      const urls = collectUrls(text, f)
      const secret = probeSecretShaped(text, f)
      if (secret && urls > 0) out.push({ rule: "workflow.secret+destination", level: "critical", kind: "exfiltration" })
      else if (secret) out.push({ rule: "workflow.secret-shaped", level: "high", kind: "credential-probing" })
      else if (urls > 0) out.push({ rule: "workflow.destination", level: "high", kind: "network-egress" })
      out.push({ rule: "workflow.preapproval", level: "medium", kind: "delegation" })
      return out
    }
    default:
      return []
  }
}

// ── 身份轴(gate 供数)────────────────────────────────────────────────────────────
function isToolIdentity(value: unknown): value is ToolIdentity {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v["source"] === "string" &&
    typeof v["origin"] === "string" &&
    typeof v["name"] === "string" &&
    ["builtin", "builtin-v2", "plugin", "mcp", "host"].includes(v["source"])
  )
}

function transportOf(value: unknown): ToolTransportFact | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v["kind"] === "mcp-remote" && typeof v["url"] === "string") return { kind: "mcp-remote", url: v["url"] }
  if (v["kind"] === "mcp-local" && Array.isArray(v["command"]))
    return { kind: "mcp-local", command: v["command"].filter((c): c is string => typeof c === "string") }
  return undefined
}

function isAlphaCloudAuthority(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["kind"] === "alpha-cloud"
}

function argString(args: unknown, ...keys: string[]): string | undefined {
  if (typeof args !== "object" || args === null) return undefined
  for (const key of keys) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === "string") return v
  }
  return undefined
}

function mcpVerdicts(identity: ToolIdentity, md: Record<string, unknown>, f: Facts): Verdict[] {
  const out: Verdict[] = []
  const transport = transportOf(md["transport"])
  const trusted = isAlphaCloudAuthority(md["authority"])
  // 目的地次序:transport(这次调用真正把字节送去的地方)排第一,args 里点名的目的地随后。
  if (transport?.kind === "mcp-remote") f.destinations.add(transport.url)
  if (transport?.kind === "mcp-local") f.programs.add(transport.command.join(" "))
  const leaves = stringLeaves(md["args"])
  const payload = leaves.join("\n")
  const hasPayload = leaves.some((leaf) => leaf.length > 0)
  const argUrls = collectUrls(payload, f)
  const secret = probeSecretShaped(payload, f)
  const credentialPath = probeCredentialPath(payload, f)

  const remoteLike = transport === undefined || transport.kind === "mcp-remote"
  if (trusted) {
    out.push({ rule: "mcp.alpha-cloud-trusted-destination", level: "medium", kind: "third-party-tool" })
  } else if (transport === undefined) {
    out.push({ rule: "mcp.transport-unknown", level: "high", kind: "third-party-tool" })
  } else if (transport.kind === "mcp-remote") {
    out.push(
      hasPayload
        ? { rule: "mcp.remote-payload", level: "high", kind: "exfiltration" }
        : { rule: "mcp.remote-no-payload", level: "medium", kind: "third-party-tool" },
    )
  } else {
    out.push({ rule: "mcp.local-transport", level: "medium", kind: "third-party-tool" })
  }
  if (argUrls > 0 && hasPayload) out.push({ rule: "mcp.args-destination", level: "high", kind: "exfiltration" })
  if (secret || credentialPath) {
    out.push(
      remoteLike && !trusted
        ? { rule: "mcp.remote+secret", level: "critical", kind: "exfiltration" }
        : { rule: "mcp.secret-in-args", level: "high", kind: "credential-probing" },
    )
  }
  void identity
  return out
}

function pluginVerdicts(md: Record<string, unknown>, f: Facts): Verdict[] {
  const out: Verdict[] = []
  const payload = stringLeaves(md["args"]).join("\n")
  const urls = collectUrls(payload, f)
  const secret = probeSecretShaped(payload, f) || probeCredentialPath(payload, f)
  if (urls > 0) out.push({ rule: "plugin.args-destination", level: "high", kind: "network-egress" })
  if (secret) out.push({ rule: "plugin.secret-in-args", level: "high", kind: "credential-probing" })
  out.push({ rule: "plugin.local-code", level: "medium", kind: "third-party-tool" })
  return out
}

function builtinVerdicts(identity: ToolIdentity, md: Record<string, unknown>, f: Facts): Verdict[] {
  const args = md["args"]
  switch (identity.name) {
    case "write":
    case "edit":
    case "multiedit": {
      const p = argString(args, "filePath", "filepath", "path")
      return pathVerdicts(p === undefined ? [] : [p], f, "write")
    }
    case "apply_patch":
      return [{ rule: "apply_patch.identity", level: "low", kind: "workspace-write" }]
    case "read": {
      const p = argString(args, "filePath", "filepath", "path")
      return pathVerdicts(p === undefined ? [] : [p], f, "read")
    }
    case "bash": {
      const command = argString(args, "command") ?? ""
      return shellVerdicts(command, programKeysLexical(command), f)
    }
    case "webfetch": {
      const url = argString(args, "url")
      return url === undefined ? [{ rule: "webfetch.identity-no-url", level: "medium", kind: "network-read" }] : urlVerdicts(url, f, "webfetch")
    }
    case "websearch": {
      const out: Verdict[] = []
      const query = argString(args, "query") ?? ""
      if (probeSecretShaped(query, f)) out.push({ rule: "websearch.secret-in-query", level: "high", kind: "exfiltration" })
      out.push({ rule: "websearch.query", level: "medium", kind: "network-read" })
      return out
    }
    case "glob":
    case "grep": {
      const out: Verdict[] = []
      const path = argString(args, "path")
      if (path !== undefined) {
        f.paths.add(path)
        if (probeCredentialPath(path, f))
          out.push({ rule: `${identity.name}.credential-path`, level: "high", kind: "credential-probing" })
      }
      out.push({ rule: `${identity.name}.workspace-search`, level: "low", kind: "workspace-read" })
      return out
    }
    case "lsp":
      return [{ rule: "lsp.workspace", level: "low", kind: "workspace-read" }]
    case "skill":
      return [{ rule: "skill.load", level: "low", kind: "workspace-read" }]
    case "todowrite":
    case "todoread":
    case "question":
    case "plan":
    case "StructuredOutput":
    case "_noop":
      return [{ rule: `${identity.name}.session`, level: "low", kind: "session-internal" }]
    case "task":
      return [{ rule: "task.subagent", level: "medium", kind: "delegation" }]
    case "execute":
      return [{ rule: "execute.code-mode", level: "medium", kind: "delegation" }]
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
    case "read_mcp_resource":
      return [{ rule: `${identity.name}.mcp-resource`, level: "medium", kind: "third-party-tool" }]
    default:
      return []
  }
}

function identityVerdicts(identity: ToolIdentity, md: Record<string, unknown>, f: Facts): Verdict[] {
  switch (identity.source) {
    case "mcp":
      return mcpVerdicts(identity, md, f)
    case "plugin":
      return pluginVerdicts(md, f)
    case "builtin":
    case "builtin-v2":
    case "host":
      return builtinVerdicts(identity, md, f)
    default:
      return []
  }
}

// ── 合成 ───────────────────────────────────────────────────────────────────────
function combine(verdicts: readonly Verdict[], f: Facts): RiskClassification {
  if (verdicts.length === 0) return fallback("fallback:unknown", f)
  let top = verdicts[0]!
  for (const v of verdicts) if (compareRiskLevel(v.level, top.level) > 0) top = v
  return {
    version: 1,
    level: top.level,
    kind: top.kind,
    rules: verdicts.map((v) => v.rule),
    facts: freeze(f),
  }
}

function freeze(f: Facts): RiskFacts {
  return {
    destinations: [...f.destinations],
    paths: [...f.paths],
    programs: [...f.programs],
    signals: [...f.signals],
  }
}

function fallback(rule: string, f: Facts): RiskClassification {
  return { version: 1, level: MOST_CONSERVATIVE_LEVEL, kind: "unknown", rules: [rule], facts: freeze(f) }
}

/**
 * 给一次授权提示打分类。总函数:不抛、不做 IO、不依赖 worktree(路径在不在工作区内由上游
 * `path.relative` 的结果形态回答)。
 */
export function classifyPermissionRequest(input: ClassifyInput): RiskClassification {
  const f = facts()
  try {
    const identity = input.metadata["identity"]
    const verdicts = isToolIdentity(identity)
      ? identityVerdicts(identity, input.metadata, f)
      : abilityVerdicts(input, f)
    return combine(verdicts, f)
  } catch {
    return fallback("fallback:classifier-threw", f)
  }
}

/** 把分类写回 metadata:**覆盖**任何入参同名键(工具/MCP 自报的低档不算数)。 */
export function withRiskClassification(
  metadata: Record<string, unknown>,
  classification: RiskClassification,
): Record<string, unknown> {
  return { ...metadata, [RISK_METADATA_KEY]: classification }
}

export function readRiskClassification(metadata: Record<string, unknown> | undefined): RiskClassification | undefined {
  const value = metadata?.[RISK_METADATA_KEY]
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v["version"] !== 1) return undefined
  if (typeof v["level"] !== "string" || !(RISK_LEVELS as readonly string[]).includes(v["level"])) return undefined
  if (typeof v["kind"] !== "string" || !(RISK_KINDS as readonly string[]).includes(v["kind"])) return undefined
  if (!Array.isArray(v["rules"])) return undefined
  return value as RiskClassification
}

export * as AlphaRiskClassification from "./alpha-risk-classification"
