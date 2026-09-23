// `#1412` —— 用户批准过的出网目的地的**真源**:读端。只有 main 写(egress-grant-truth-write.ts),任何进程可读。
// 与 `#1381` 的远程 MCP 真源(mcp-server-truth.ts)、`#1391` 的自定义节点真源(custom-provider-truth.ts)同形、
// 同一个父目录、**不同文件**:三种记录形状不同,不往一个文件里塞三种东西。
//
// ── 为什么要有这份文件 ──────────────────────────────────────────────────────────
// 出网放行集合的前两个半场都要求「目的地有一个围栏外的真源」。`webfetch` 的 URL 与 `bash` 里命令自带的
// 目的地由模型在调用那一刻产生,**没有配置来源**(`#1414` §3),于是整类被拒 —— 实测 `en.wikipedia.org` /
// `example.com` / `raw.githubusercontent.com` 全 403,而同一批里静态表内的 `github.com` 取回 576 KB。
// 本文件给「用户点的那一下」一个引擎写不到的家:`<appData>/alpha-code-state/egress-grants/<env>.json`,
// 与三个 env 根、`cas/`、`fence-workspaces/`、`custom-providers/`、`mcp-servers/` 同级 —— 父目录是
// alpha-environment.ts 冻结快照的 `casBaseRoot`;可写集的固定行没有一行罩得住它(判据:egress-grant-truth.test.ts
// 对着生产渲染的 profile 逐行枚举)。放在任何一个可写根下 = 围栏内的代码可以给自己批准出网(confused deputy)。
//
// ── 形状 ─────────────────────────────────────────────────────────────────────
// `{ "v": 1, "grants": [{ "host", "port", "at" }] }`。`at` 是批准发生的时刻(ISO-8601 字符串),
// 它是这一行的**出处坐标** —— 评审与用户据此判「这一条凭什么在」,与静态表每行带 source 同一条纪律。
// 读:**严格** —— 缺失 = 「没批准过」(ok,空清单,零日志,这是绝大多数用户的正常状态);解析失败 /
// 版本不认识 / 字段不合法 / 同一 host:port 重复 / 多余的键 ⇒ 「没问出来」(ok:false),**不是空记录**,
// 并经注入的 log 出一行原因(`#1387`)。两种结局在**行为**上相同(都不放行任何东西),在日志上可分辨。
// 字段判据只问「是不是这个形状」;**地址准入**(非 loopback / 非内网字面量 / host 形状 / 端口范围)是
// network-egress-grants.ts 的 `admitUserEgressGrant` 那一份,这里不抄第二份;装载时它再判一次,
// 所以一条手改进来的坏地址最多是「不放行」,不会是「放行了一个不该放的」。
//
// ── 读与写为什么拆成两个文件 ───────────────────────────────────────────────────
// 理由逐字同 mcp-server-truth.ts 文件头。本文件**零写盘**(连 node:fs 都不 import,读也经注入的 fs);
// 写在 egress-grant-truth-write.ts。electron-free。

import { resolve } from "node:path"
import type { AppEnvironment } from "./alpha-environment"

export const EGRESS_GRANTS_DIRNAME = "egress-grants"
export const EGRESS_GRANT_TRUTH_VERSION = 1

export type EgressGrantRecord = {
  /** 小写 DNS 名或 IPv4 字面量;不带 scheme / path / 通配(准入由 admitUserEgressGrant 判)。 */
  host: string
  port: number
  /** 批准发生的时刻,ISO-8601。这一行的出处坐标。 */
  at: string
}

/** `<casBaseRoot>/egress-grants/<env>.json` —— 与 `env/`、`cas/`、`mcp-servers/` 同级(见文件头)。 */
export function egressGrantTruthPath(casBaseRoot: string, environment: AppEnvironment): string {
  return resolve(casBaseRoot, EGRESS_GRANTS_DIRNAME, `${environment}.json`)
}

export type EgressGrantTruthReadDeps = {
  readFileSync: (path: string, encoding: "utf8") => string
  /** 拒绝时出一行原因(必填:没接日志的消费者会把「没问出来」读成「没批准过」)。缺失是正常状态,不出声。 */
  log: (line: string) => void
}

export type EgressGrantTruthRead = { ok: true; absent: boolean; grants: EgressGrantRecord[] } | { ok: false; reason: string }

const RECORD_KEYS: readonly string[] = ["host", "port", "at"]
const TOP_KEYS: readonly string[] = ["v", "grants"]

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined
}

/** 单条记录的结构判据:合法返回 undefined,否则返回可读原因(点名第几条、哪个字段)。多余的键一律拒。 */
export function invalidEgressGrantRecord(entry: unknown, label: string): string | undefined {
  if (!isRecord(entry)) return `${label} is not an object`
  const unexpected = Object.keys(entry).filter((k) => !RECORD_KEYS.includes(k))
  if (unexpected.length) return `${label} has unexpected key(s): ${unexpected.join(", ")}`
  if (typeof entry.host !== "string" || entry.host.length === 0) return `${label}.host is not a non-empty string: ${JSON.stringify(entry.host)}`
  if (!Number.isInteger(entry.port) || (entry.port as number) < 1 || (entry.port as number) > 65535)
    return `${label}.port is not a port number: ${JSON.stringify(entry.port)}`
  if (typeof entry.at !== "string" || entry.at.length === 0) return `${label}.at is not a timestamp: ${JSON.stringify(entry.at)}`
  return undefined
}

/** 整份清单的判据(写端落盘前过的也是这一份):每条记录合法且 `host:port` 不重复。 */
export function invalidEgressGrantList(entries: unknown, label = "grants"): string | undefined {
  if (!Array.isArray(entries)) return `\`${label}\` is not an array`
  const seen = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const bad = invalidEgressGrantRecord(entry, `${label}[${i}]`)
    if (bad) return bad
    const record = entry as EgressGrantRecord
    const k = `${record.host.toLowerCase()}:${record.port}`
    if (seen.has(k)) return `${label}[${i}] duplicates an earlier record: ${JSON.stringify(k)}`
    seen.add(k)
  }
  return undefined
}

/** 固定键序:读回的对象不带文件里的键序,写端用同一个函数得到确定的字节。 */
export function canonicalEgressGrantRecord(r: EgressGrantRecord): EgressGrantRecord {
  return { host: r.host, port: r.port, at: r.at }
}

/** 严格读(见文件头)。缺失 ⇒ ok + absent + 空清单;其余任何不对 ⇒ ok:false + 一行日志。 */
export function readEgressGrantTruth(path: string, deps: EgressGrantTruthReadDeps): EgressGrantTruthRead {
  const reject = (reason: string): EgressGrantTruthRead => {
    deps.log(
      `egress grants: truth file ${path} rejected — ${reason}; no user-approved destination is authorized (this is "unanswerable", not "nothing approved") until the app rewrites it`,
    )
    return { ok: false, reason: `${path}: ${reason}` }
  }
  let text: string
  try {
    text = deps.readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, absent: true, grants: [] }
    return reject(`read failed (${errorMessage(error)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return reject(`not JSON (${errorMessage(error)})`)
  }
  if (!isRecord(parsed)) return reject("not a JSON object")
  if (parsed.v !== EGRESS_GRANT_TRUTH_VERSION) return reject(`unsupported version ${JSON.stringify(parsed.v)} (expected ${EGRESS_GRANT_TRUTH_VERSION})`)
  const unexpected = Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k))
  if (unexpected.length) return reject(`unexpected top-level key(s): ${unexpected.join(", ")}`)
  const bad = invalidEgressGrantList(parsed.grants)
  if (bad) return reject(bad)
  return { ok: true, absent: false, grants: (parsed.grants as EgressGrantRecord[]).map(canonicalEgressGrantRecord) }
}
