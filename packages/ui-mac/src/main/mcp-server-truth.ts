// `#1381`(`#1383` 基线 §四 子票 4)—— 用户自配的**远程 MCP 服务器**记录的**真源**:读端。只有 main 写(mcp-server-truth-write.ts),
// 任何进程可读。与 `#1391` 的自定义节点真源(custom-provider-truth.ts)同形、同一个父目录、**不同文件**:两种记录形状不同,
// 不往一个文件里塞两种东西。
//
// ── 为什么要有这份文件 ──────────────────────────────────────────────────────────
// 「接入其它服务」里配的远程 MCP 连接器,`#1381` 之前落在 `<alphaGlobalRoot>/alpha.jsonc`(ext-config.ts persistMcp,写键
// `mcp.<name>`)—— 那是可写根 W2,**被围栏的引擎树自己写得了**;出网围栏因此不敢照它放行(network-egress-derived.ts 文件头),
// 真机实测(票面 2026-09-21):`mcp.deepwiki.com:443` → `verdict:"deny" reason:"unregistered"`,连接器一个都连不上,而拦它的是我们自己。
// 本文件给它一个引擎写不到的家:`<appData>/alpha-code-state/mcp-servers/<env>.json`,与三个 env 根、`cas/`、`fence-workspaces/`、
// `custom-providers/` 同级 —— 父目录是 alpha-environment.ts 冻结快照的 `casBaseRoot`;W2 只放行 `env/<env>`,W3 是 `<userData>`
// (另一棵树),其余固定行都不覆盖它(mcp-server-truth.test.ts 对着生产渲染的 profile 逐行枚举 W-id 断言;真 sandbox-exec 的裁决
// 由 custom-provider-truth-fence.test.ts 对同一个父目录下的兄弟文件给出,两个真源在围栏眼里是同一条规则)。
//
// ── 形状 ─────────────────────────────────────────────────────────────────────
// `{ "v": 1, "servers": [{ "name", "url", "headers"? }] }`。`name` 是扩展名(isExtensionName,与账本 / 配置键同一份判据);
// `headers` 可选、值是字符串(引擎 v1 Remote schema:`headers?: Record<string,string>`)。**本地 MCP 不进这里**(它不需要出网授权,
// 仍住 alpha.jsonc);`enabled` 也不进这里 —— 启停是账本(installs.json desiredState)的事,由 sidecar 注入 `enabled:false` 压住。
// 读:**严格** —— 缺失 = 「没有记录」(ok,空清单;用户没加过连接器是正常状态,不出声);解析失败 / 版本不认识 / 字段不合法 /
// 同名重复 / 多余的键 ⇒ 「没问出来」(ok:false),**不是空记录**,并经注入的 log 出一行原因(`#1387`:静默的失败路径事后
// 无法与「一切正常」区分)。不猜、不修、不改写。字段判据只问「是不是这个形状」;地址准入(https / 非 loopback / host 形状)是
// 添加时与出网同源的那一份(network-egress-derived.ts classifyBaseUrl,基线 I4),这里不抄第二份;派生时它再判一次,所以一条
// 溜进来的坏地址最多是「不放行」,不会是「放行了一个不该放的」。
//
// ── 读与写为什么拆成两个文件 ───────────────────────────────────────────────────
// 理由逐字同 custom-provider-truth.ts 文件头:读端要进 sidecar 的 import 闭包(alpha-config-injection.ts 从这里读),写入点若跟着进
// 闭包,写盘登记簿只能给它填 `main-only` 这个文字标签。所以本文件**零写盘**(连 node:fs 都不 import,读也经注入的 fs);写在
// mcp-server-truth-write.ts,它不进闭包由 mcp-server-truth.test.ts 对着生产的闭包工具实测。electron-free。

import { resolve } from "node:path"
import { isExtensionName } from "../shared/extension-name"
import type { AppEnvironment } from "./alpha-environment"

export const MCP_SERVERS_DIRNAME = "mcp-servers"
export const MCP_SERVER_TRUTH_VERSION = 1

export type McpServerRecord = {
  name: string
  url: string
  headers?: Record<string, string>
}

/** `<casBaseRoot>/mcp-servers/<env>.json` —— 与 `env/`、`cas/`、`custom-providers/` 同级(见文件头)。 */
export function mcpServerTruthPath(casBaseRoot: string, environment: AppEnvironment): string {
  return resolve(casBaseRoot, MCP_SERVERS_DIRNAME, `${environment}.json`)
}

export type McpServerTruthReadDeps = {
  readFileSync: (path: string, encoding: "utf8") => string
  /** 拒绝时出一行原因(必填:没接日志的消费者会把「没问出来」读成「没有」)。缺失是正常状态,不出声。 */
  log: (line: string) => void
}

export type McpServerTruthRead = { ok: true; absent: boolean; servers: McpServerRecord[] } | { ok: false; reason: string }

const RECORD_KEYS: readonly string[] = ["name", "url", "headers"]
const TOP_KEYS: readonly string[] = ["v", "servers"]

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** 单条记录的结构判据:合法返回 undefined,否则返回可读原因(点名第几条、哪个字段)。多余的键一律拒。 */
export function invalidMcpServerRecord(entry: unknown, label: string): string | undefined {
  if (!isRecord(entry)) return `${label} is not an object`
  const unexpected = Object.keys(entry).filter((k) => !RECORD_KEYS.includes(k))
  if (unexpected.length) return `${label} has unexpected key(s): ${unexpected.join(", ")}`
  if (typeof entry.name !== "string" || !isExtensionName(entry.name)) return `${label}.name is not an extension name: ${JSON.stringify(entry.name)}`
  if (typeof entry.url !== "string" || !parsesAsUrl(entry.url)) return `${label}.url is not a URL: ${JSON.stringify(entry.url)}`
  if (entry.headers !== undefined) {
    if (!isRecord(entry.headers)) return `${label}.headers is not an object`
    for (const [k, v] of Object.entries(entry.headers)) if (typeof v !== "string") return `${label}.headers[${JSON.stringify(k)}] is not a string`
  }
  return undefined
}

/** 整份清单的判据(写端落盘前过的也是这一份):每条记录合法且 name 不重复。 */
export function invalidMcpServerList(entries: unknown, label = "servers"): string | undefined {
  if (!Array.isArray(entries)) return `\`${label}\` is not an array`
  const seen = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const bad = invalidMcpServerRecord(entry, `${label}[${i}]`)
    if (bad) return bad
    const name = (entry as McpServerRecord).name
    if (seen.has(name)) return `${label}[${i}].name duplicates an earlier record: ${JSON.stringify(name)}`
    seen.add(name)
  }
  return undefined
}

/** 固定键序 + headers 拷贝:读回的对象不带文件里的键序,写端用同一个函数得到确定的字节。没有 headers 就没有这个键。 */
export function canonicalMcpServerRecord(r: McpServerRecord): McpServerRecord {
  return { name: r.name, url: r.url, ...(r.headers ? { headers: { ...r.headers } } : {}) }
}

/** 严格读(见文件头)。缺失 ⇒ ok + absent + 空清单;其余任何不对 ⇒ ok:false + 一行日志。 */
export function readMcpServerTruth(path: string, deps: McpServerTruthReadDeps): McpServerTruthRead {
  const reject = (reason: string): McpServerTruthRead => {
    deps.log(
      `remote MCP servers: truth file ${path} rejected — ${reason}; nothing is derived from it (this is "unanswerable", not an empty list) until the app rewrites it`,
    )
    return { ok: false, reason: `${path}: ${reason}` }
  }
  let text: string
  try {
    text = deps.readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, absent: true, servers: [] }
    return reject(`read failed (${errorMessage(error)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return reject(`not JSON (${errorMessage(error)})`)
  }
  if (!isRecord(parsed)) return reject("not a JSON object")
  if (parsed.v !== MCP_SERVER_TRUTH_VERSION) return reject(`unsupported version ${JSON.stringify(parsed.v)} (expected ${MCP_SERVER_TRUTH_VERSION})`)
  const unexpected = Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k))
  if (unexpected.length) return reject(`unexpected top-level key(s): ${unexpected.join(", ")}`)
  const bad = invalidMcpServerList(parsed.servers)
  if (bad) return reject(bad)
  return { ok: true, absent: false, servers: (parsed.servers as McpServerRecord[]).map(canonicalMcpServerRecord) }
}
