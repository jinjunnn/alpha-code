// office-advisories — REQ-105 archived Office guidance + REQ-133 Alpha first-party registry +
// REQ-135 retired community Office denial.
//
// 背景：2026-07-10 安全复核，交付记录见 GitHub issue #197。
//   * REQ-080 上架的 Word/PPT MCP 上游仓库已于 2026-03-03 被作者归档(不再维护 → 供应链风险)。
//   * REQ-135 retires the separate community Excel MCP. It is denied by exact catalog/name facts;
//     the supported Hub Excel connector is the distinct first-party `mcp:alpha-excel` entry.
//
// 本模块是 main 与 renderer 共用的纯数据 + 纯函数(无 node/electron 依赖):
//   * ARCHIVED_OFFICE_ADVISORIES / officeAdvisoryFor —— Hub 的诚实处置面:已安装用户看到
//     archived+unsupported 徽标与指引,禁自动更新;绝不静默删除用户安装(卸载走既有 receipts
//     可审计路径)。
//   * RETIRED_COMMUNITY_OFFICE_CONNECTORS / retiredCommunityOfficeFor —— 新安装/重新激活的
//     随包静态拒绝事实。它不复用 archived keep-installed 语义。
//   * ALPHA_OFFICE_CONNECTORS / checkAlphaOfficeMcpSafety —— four Alpha-authored bundled stdio
//     entrypoints, exact dependency pins, and the shared workspace-policy membership for REQ-133.
//
// 远程签名 advisory 通道是 REQ-101 的未来工作;本表是其之前的最小诚实路径(随包静态数据)。

export interface OfficeAdvisory {
  /** C 侧 catalog 条目 id(receipts.id 记的就是它)。 */
  catalogId: string
  /** MCP server 名 = 安装名(receipts.name / SDK mcp.status 键)。 */
  name: string
  /** pypi 包名(命令行 / 守卫扫描用)。 */
  pypiPackage: string
  kind: "archived"
  /** 上游归档日期(ISO)。 */
  archivedAt: string
}

/** 上游已归档(unmaintained)的 Office 连接器 —— REQ-105 决定:移出推荐/预缓存/默认 bundle;
 *  已安装用户保留 + 显式 archived 警示(不静默删除)。 */
export const ARCHIVED_OFFICE_ADVISORIES: readonly OfficeAdvisory[] = [
  {
    catalogId: "mcp:word",
    name: "office-word-mcp-server",
    pypiPackage: "office-word-mcp-server",
    kind: "archived",
    archivedAt: "2026-03-03",
  },
  {
    catalogId: "mcp:powerpoint",
    name: "office-powerpoint-mcp-server",
    pypiPackage: "office-powerpoint-mcp-server",
    kind: "archived",
    archivedAt: "2026-03-03",
  },
] as const

export interface RetiredCommunityOfficeConnector {
  catalogId: string
  name: string
  pypiPackage: string
  kind: "retired"
}

/** REQ-135 owner lock: the old community Excel connector is torn down and cannot be installed or
 *  reactivated. This table deliberately stays separate from archived Word/PPT keep-installed
 *  advisories so their behavior and Hub guidance do not change. */
export const RETIRED_COMMUNITY_OFFICE_CONNECTORS: readonly RetiredCommunityOfficeConnector[] = [
  {
    catalogId: "mcp:excel",
    name: "excel-mcp-server",
    pypiPackage: "excel-mcp-server",
    kind: "retired",
  },
] as const

export type AlphaOfficeFormat = "word" | "excel" | "powerpoint" | "pdf"
export const WORKSPACE_MARKER = "{workspace}"

/** REQ-133 first-party Office MCP facts. This is the single code-side authority consumed by the
 *  planner, write policy, tests, and factory skill; the signed web catalog remains the card source. */
export const ALPHA_OFFICE_CONNECTORS = [
  {
    catalogId: "mcp:alpha-word",
    name: "alpha-word",
    format: "word",
    extension: ".docx",
    dependencies: ["python-docx==1.2.0"],
  },
  {
    catalogId: "mcp:alpha-excel",
    name: "alpha-excel",
    format: "excel",
    extension: ".xlsx",
    dependencies: ["openpyxl==3.1.5"],
  },
  {
    catalogId: "mcp:alpha-powerpoint",
    name: "alpha-powerpoint",
    format: "powerpoint",
    extension: ".pptx",
    dependencies: ["python-pptx==1.0.2"],
  },
  {
    catalogId: "mcp:alpha-pdf",
    name: "alpha-pdf",
    format: "pdf",
    extension: ".pdf",
    dependencies: ["pypdf==6.16.1", "reportlab==5.0.0"],
  },
] as const satisfies ReadonlyArray<{
  catalogId: string
  name: string
  format: AlphaOfficeFormat
  extension: string
  dependencies: readonly string[]
}>

/** Exact local command copied by each alpha-web catalog card. Main owns both substitutions. */
export function alphaOfficeInstallCommand(format: AlphaOfficeFormat): string[] {
  const connector = ALPHA_OFFICE_CONNECTORS.find((candidate) => candidate.format === format)
  if (!connector) throw new Error(`unknown Alpha Office format: ${format}`)
  return [
    "uv",
    "run",
    "--no-project",
    ...connector.dependencies.flatMap((dependency) => ["--with", dependency]),
    "{alphaResources}/office-mcp/server.py",
    format,
    WORKSPACE_MARKER,
  ]
}

/** 按 catalog id / 安装名匹配 advisory(receipts.id、receipts.name、live MCP server 名都可传)。 */
export function officeAdvisoryFor(ref: { id?: string; name?: string }): OfficeAdvisory | undefined {
  return ARCHIVED_OFFICE_ADVISORIES.find(
    (a) => (ref.id !== undefined && ref.id === a.catalogId) || (ref.name !== undefined && ref.name === a.name),
  )
}

/** Exact legacy identity match. `mcp:alpha-excel` / `alpha-excel` is intentionally distinct. */
export function retiredCommunityOfficeFor(
  ref: { id?: string; name?: string },
): RetiredCommunityOfficeConnector | undefined {
  return RETIRED_COMMUNITY_OFFICE_CONNECTORS.find(
    (connector) =>
      (ref.id !== undefined && ref.id === connector.catalogId) ||
      (ref.name !== undefined && ref.name === connector.name),
  )
}

export type OfficeSafetyVerdict = { ok: true } | { ok: false; reason: string }

const ALPHA_OFFICE_BANNED_ENV = new Set(["HOST", "PORT", "MCP_HOST", "MCP_PORT", "MCP_TRANSPORT", "FASTMCP_HOST", "FASTMCP_PORT"])
const ALPHA_OFFICE_ALLOWED_ENV = new Set(["UV_DEFAULT_INDEX", "PIP_INDEX_URL", "npm_config_registry"])

function alphaOfficeConnector(name: string, command: readonly string[]) {
  const named = ALPHA_OFFICE_CONNECTORS.find((connector) => connector.name === name)
  if (named) return named
  const script = command.findIndex((argument) => normalizeSlashes(argument).endsWith("/office-mcp/server.py"))
  if (script < 0) return undefined
  return ALPHA_OFFICE_CONNECTORS.find((connector) => command[script + 1] === connector.format)
}

/** 纯字符串路径检查(shared 模块不引 node:path,renderer 亦可用)。 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}
function hasTraversal(p: string): boolean {
  return normalizeSlashes(p)
    .split("/")
    .some((seg) => seg === "..")
}
function isAbsolutePath(p: string): boolean {
  const n = normalizeSlashes(p)
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n)
}

/** REQ-133 persistence gate: only the exact Alpha-authored bundled stdio command may be durable. */
export function checkAlphaOfficeMcpSafety(
  name: string,
  server: Record<string, unknown>,
  workspace?: string,
  alphaResources?: string,
): OfficeSafetyVerdict {
  const command = Array.isArray(server.command) ? (server.command as unknown[]).filter((argument): argument is string => typeof argument === "string") : []
  const connector = alphaOfficeConnector(name, command)
  if (!connector) return { ok: true }
  if (server.type !== "local" || ["url", "host", "port", "transport"].some((key) => key in server)) {
    return { ok: false, reason: `${connector.name} only allows local stdio; remote transport is refused (REQ-133)` }
  }
  if (!workspace || !alphaResources || (workspace !== WORKSPACE_MARKER && !isAbsolutePath(workspace)) || !isAbsolutePath(alphaResources)) {
    return { ok: false, reason: `${connector.name} requires the workspace marker or absolute managed workspace plus an absolute Alpha resource root (REQ-134)` }
  }
  if (hasTraversal(workspace) || hasTraversal(alphaResources)) {
    return { ok: false, reason: `${connector.name} path contains traversal segments (REQ-133)` }
  }
  const expected = alphaOfficeInstallCommand(connector.format).map((argument) =>
    argument
      .split("{alphaResources}")
      .join(normalizeSlashes(alphaResources).replace(/\/+$/, ""))
      .split(WORKSPACE_MARKER)
      .join(workspace),
  )
  if (command.length !== expected.length || command.some((argument, index) => normalizeSlashes(argument) !== normalizeSlashes(expected[index]!))) {
    return { ok: false, reason: `${connector.name} command must match the pinned bundled stdio command exactly (REQ-133)` }
  }
  const env =
    server.environment && typeof server.environment === "object" && !Array.isArray(server.environment)
      ? (server.environment as Record<string, unknown>)
      : {}
  for (const [key, value] of Object.entries(env)) {
    if (!ALPHA_OFFICE_ALLOWED_ENV.has(key) || ALPHA_OFFICE_BANNED_ENV.has(key.toUpperCase()) || (typeof value === "string" && value.includes("0.0.0.0"))) {
      return { ok: false, reason: `${connector.name} unapproved runtime environment is refused (REQ-133)` }
    }
  }
  return { ok: true }
}

/** First-party Office recognition by stable name or bundled script + format entrypoint. */
export function isAlphaOfficeMcp(name: string, server: Record<string, unknown>): boolean {
  const command = Array.isArray(server.command) ? (server.command as unknown[]).filter((argument): argument is string => typeof argument === "string") : []
  return alphaOfficeConnector(name, command) !== undefined
}

/** Main write-policy recognition for the retired connector. Exact name and package command matching
 *  prevent a renamed uncurated install from bypassing the REQ-135 denial. */
export function isRetiredOfficeMcp(name: string, server: Record<string, unknown>): boolean {
  if (retiredCommunityOfficeFor({ name })) return true
  const command = Array.isArray(server.command)
    ? (server.command as unknown[]).filter((argument): argument is string => typeof argument === "string")
    : []
  return RETIRED_COMMUNITY_OFFICE_CONNECTORS.some((connector) =>
    command.some((argument) => {
      const packageFlag = ["--from=", "--with=", "--with-editable=", "-w="].find((prefix) =>
        argument.startsWith(prefix),
      )
      const shortWith = !packageFlag && argument.startsWith("-") && !argument.startsWith("--")
        ? argument.indexOf("w", 1)
        : -1
      const rawCandidate = packageFlag
        ? argument.slice(packageFlag.length)
        : shortWith >= 1 && shortWith < argument.length - 1
          ? argument.slice(shortWith + 1)
          : argument
      const candidate = (rawCandidate.startsWith("=") ? rawCandidate.slice(1) : rawCandidate).trim()
      const normalized = candidate.toLowerCase().replace(/[._-]+/g, "-")
      const distribution = connector.pypiPackage.toLowerCase().replace(/[._-]+/g, "-")
      if (!normalized.startsWith(distribution)) return false
      const separator = normalized[distribution.length]
      return separator === undefined || ["@", "=", "<", ">", "!", "~", "[", ";"].includes(separator) || /\s/.test(separator)
    }),
  )
}

/** Planner/persistence registry for first-party workspace-scoped Office MCPs. */
export function isWorkspacePolicyMcp(name: string, server: Record<string, unknown>): boolean {
  return isAlphaOfficeMcp(name, server)
}
