// office-advisories — REQ-105 Office Catalog 安全纠偏,A 侧数据真源(jinjunnn/alpha-code#197)。
//
// 背景(2026-07-10 安全复核,详见 docs/requirements/REQ-105-office-catalog-safety.md):
//   * REQ-080 上架的 Word/PPT MCP 上游仓库已于 2026-03-03 被作者归档(不再维护 → 供应链风险)。
//   * Excel MCP(excel-mcp-server)曾有路径遍历 / 未认证远程读写 advisory,0.1.8 修复 —— 必须
//     精确锁定审计版本,且仅允许 local stdio + workspace sandbox(禁 0.0.0.0 / 远程 transport)。
//
// 本模块是 main 与 renderer 共用的纯数据 + 纯函数(无 node/electron 依赖):
//   * ARCHIVED_OFFICE_ADVISORIES / officeAdvisoryFor —— Hub 的诚实处置面:已安装用户看到
//     archived+unsupported 徽标与指引,禁自动更新;绝不静默删除用户安装(卸载走既有 receipts
//     可审计路径)。
//   * EXCEL_MCP_PIN —— 审计锁定记录(版本 + pypi digest)。升级必须重新 intake 并 bump 本记录,
//     否则 alpha-catalog.test.ts 与 scripts/assert-seed-assets.sh 的守卫直接红(AC2)。
//   * checkExcelMcpSafety —— persistMcp 写盘闸口(ext-ipc)的 Excel sandbox 校验:拒绝远程
//     transport、未钉版本、非 stdio 子命令、host/port 绑定(0.0.0.0)与 workspace 外 / 遍历路径。
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

/** Excel 连接器审计锁定记录(2026-07-12 本轮 intake;digest 取自 pypi excel-mcp-server 0.1.8)。
 *  升级 = 重新 intake + 手动改这里(带动测试/守卫一起改)—— 禁 `>=` / 漂移版本。 */
export const EXCEL_MCP_PIN = {
  catalogId: "mcp:excel",
  name: "excel-mcp-server",
  pypiPackage: "excel-mcp-server",
  version: "0.1.8",
  /** 命令行里必须逐字出现的钉版包参数。 */
  pinnedSpec: "excel-mcp-server@0.1.8",
  /** pypi 工件 sha256(审计记录;uvx 无逐工件校验通道,记录供 intake/追溯)。 */
  sdistSha256: "98f6b25957cc105a0d68d9a98a5830204ab3f3f7a79de27a91ae8d1a9291fdcd",
  wheelSha256: "c75668094697152b9d749939c071ea02ac418635c8a11636396bd9797609f5a5",
  /** 该版本修复的安全公告(为什么必须锁死在这)。 */
  fixedAdvisory: "path traversal + unauthenticated remote read/write(< 0.1.8)",
} as const

/** 按 catalog id / 安装名匹配 advisory(receipts.id、receipts.name、live MCP server 名都可传)。 */
export function officeAdvisoryFor(ref: { id?: string; name?: string }): OfficeAdvisory | undefined {
  return ARCHIVED_OFFICE_ADVISORIES.find(
    (a) => (ref.id !== undefined && ref.id === a.catalogId) || (ref.name !== undefined && ref.name === a.name),
  )
}

export type OfficeSafetyVerdict = { ok: true } | { ok: false; reason: string }

const EXCEL_BANNED_TRANSPORTS = new Set(["sse", "http", "streamable-http"])
// excel-mcp-server(fastmcp 系)的宿主/端口绑定通道 —— 任何一个出现都可能把 server 开到网络上。
const EXCEL_BANNED_ENV = new Set(["FASTMCP_HOST", "FASTMCP_PORT", "EXCEL_MCP_HOST", "EXCEL_MCP_PORT", "HOST", "PORT"])

function isExcelCommand(command: readonly string[]): boolean {
  return command.some((arg) => arg === EXCEL_MCP_PIN.pypiPackage || arg.startsWith(`${EXCEL_MCP_PIN.pypiPackage}@`) || arg.startsWith(`${EXCEL_MCP_PIN.pypiPackage}>`) || arg.startsWith(`${EXCEL_MCP_PIN.pypiPackage}<`) || arg.startsWith(`${EXCEL_MCP_PIN.pypiPackage}=`))
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
function isInside(child: string, parent: string): boolean {
  const c = normalizeSlashes(child).replace(/\/+$/, "")
  const p = normalizeSlashes(parent).replace(/\/+$/, "")
  return c === p || c.startsWith(`${p}/`)
}

/**
 * REQ-105 Excel sandbox 闸口:excel-mcp-server 的 MCP 配置只放行「local stdio + 审计钉版 +
 * 零网络绑定 + workspace 内文件路径」。非 Excel 配置原样放行(本闸口只认这一个包)。
 *
 * @param name    MCP server 安装名。
 * @param server  即将持久化的 MCP 配置(ConfigV2.MCP 形状:type/command/url/environment)。
 * @param workspace 已知的 workspace 根(可选)——提供时 EXCEL_FILES_PATH 必须落在其内。
 */
export function checkExcelMcpSafety(
  name: string,
  server: Record<string, unknown>,
  workspace?: string,
): OfficeSafetyVerdict {
  const type = server.type
  const command = Array.isArray(server.command) ? (server.command as unknown[]).filter((a): a is string => typeof a === "string") : []
  const touchesExcel = name === EXCEL_MCP_PIN.name || isExcelCommand(command)
  if (!touchesExcel) {
    // remote 形态没有 command 可认包 —— 仅在名字点名 excel 时兜住(上面已覆盖);其余放行。
    return { ok: true }
  }

  // ① 仅 local stdio:远程 transport(TCP/HTTP/SSE)在 < 0.1.8 有未认证读写前科,一律拒绝。
  if (type !== "local") {
    return { ok: false, reason: `excel-mcp-server 仅允许 local stdio(REQ-105 安全纠偏);远程 transport 禁止` }
  }

  // ② 精确锁定审计版本:不得漂移 / 不得 >=(升级须重新 intake 并 bump EXCEL_MCP_PIN)。
  if (!command.includes(EXCEL_MCP_PIN.pinnedSpec)) {
    return {
      ok: false,
      reason: `excel-mcp-server 必须精确钉审计版本 ${EXCEL_MCP_PIN.pinnedSpec}(REQ-105);当前命令未钉或版本漂移`,
    }
  }

  // ③ 子命令只允许 stdio;sse / streamable-http 会监听端口。
  if (command.some((a) => EXCEL_BANNED_TRANSPORTS.has(a.toLowerCase()))) {
    return { ok: false, reason: `excel-mcp-server 禁止网络 transport 子命令(仅 stdio,REQ-105)` }
  }
  if (!command.includes("stdio")) {
    return { ok: false, reason: `excel-mcp-server 命令缺少 stdio 子命令(唯一放行的 transport,REQ-105)` }
  }

  // ④ 禁 host/port 绑定:flag 或 env 任一通道出现都拒绝;0.0.0.0 逐字扫描(flag=、env 值)。
  if (command.some((a) => a === "--host" || a === "--port" || a.startsWith("--host=") || a.startsWith("--port="))) {
    return { ok: false, reason: `excel-mcp-server 禁止 --host/--port 绑定参数(REQ-105)` }
  }
  const env =
    server.environment && typeof server.environment === "object" && !Array.isArray(server.environment)
      ? (server.environment as Record<string, unknown>)
      : {}
  for (const [k, v] of Object.entries(env)) {
    if (EXCEL_BANNED_ENV.has(k.toUpperCase())) {
      return { ok: false, reason: `excel-mcp-server 禁止宿主/端口绑定环境变量 ${k}(REQ-105)` }
    }
    if (typeof v === "string" && v.includes("0.0.0.0")) {
      return { ok: false, reason: `excel-mcp-server 配置含 0.0.0.0(全网卡监听),拒绝(REQ-105)` }
    }
  }
  if (command.some((a) => a.includes("0.0.0.0"))) {
    return { ok: false, reason: `excel-mcp-server 配置含 0.0.0.0(全网卡监听),拒绝(REQ-105)` }
  }

  // ⑤ workspace sandbox:EXCEL_FILES_PATH(该包的文件根)必须是绝对路径、零遍历段;
  //    已知 workspace 时必须落在其内。
  const filesPath = env.EXCEL_FILES_PATH
  if (typeof filesPath === "string" && filesPath.length > 0) {
    if (!isAbsolutePath(filesPath)) {
      return { ok: false, reason: `EXCEL_FILES_PATH 必须是绝对路径(REQ-105 workspace sandbox)` }
    }
    if (hasTraversal(filesPath)) {
      return { ok: false, reason: `EXCEL_FILES_PATH 含路径遍历段(..),拒绝(REQ-105)` }
    }
    if (workspace && !isInside(filesPath, workspace)) {
      return { ok: false, reason: `EXCEL_FILES_PATH 超出 workspace 边界,拒绝(REQ-105)` }
    }
  }

  return { ok: true }
}
