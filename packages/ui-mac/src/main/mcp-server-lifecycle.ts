// `#1381` —— 远程 MCP 服务器真源的 **main 侧读改写**(添加 / 删除 / 失败补偿)。只有 main 会 import 本文件(ext-config.ts,
// 它自 `#1392` 起不在 sidecar 的 import 闭包里);本文件引入写端,所以**不得**进闭包(mcp-server-truth.test.ts 实测)。
//
// 三个动作都是「严格读整份 → 改一条 → 原子写整份」:真源坏了(解析失败 / 形状不对 / 位置未知)⇒ **拒绝**并说原因,不在坏文件上
// 叠加写(与 `#1392` provider-lifecycle.ts 同一条纪律:真源坏了 add / remove 都拒,由用户或下一次成功的写修好它)。
// 缺失 = 空清单,正常。返回 ConfigResult 形状,ext-config.ts 的调用方原样透传。

import * as fs from "node:fs"
import { resolveMcpServerTruthLocation } from "./mcp-server-records"
import { canonicalMcpServerRecord, readMcpServerTruth, type McpServerRecord } from "./mcp-server-truth"
import { writeMcpServerTruth } from "./mcp-server-truth-write"

export type McpServerTruthResult = { ok: true } | { ok: false; reason: string }

type Loaded = { ok: true; path: string; servers: McpServerRecord[] } | { ok: false; reason: string; unresolved: boolean }

/**
 * 位置未知(unresolved)与文件坏了(corrupt)分开:前者对本进程意味着「没有真源文件」—— 读端(sidecar / 出网)用同一份解析,
 * 也什么都不会派生,所以 remove / find 按「没有记录」答(幂等 / undefined),只有 upsert 拒(没有地方可写);
 * 后者两个方向都拒 —— 不在坏文件上叠加写,也不假装它是空的。
 */
function load(log: (line: string) => void): Loaded {
  const location = resolveMcpServerTruthLocation()
  if (!location.ok) return { ok: false, reason: `remote MCP truth location unresolved: ${location.reason}`, unresolved: true }
  const read = readMcpServerTruth(location.path, { readFileSync: fs.readFileSync, log })
  if (!read.ok) return { ok: false, reason: `remote MCP truth unreadable: ${read.reason}`, unresolved: false }
  return { ok: true, path: location.path, servers: read.servers }
}

function commit(path: string, servers: readonly McpServerRecord[]): McpServerTruthResult {
  try {
    writeMcpServerTruth(path, servers, fs)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `remote MCP truth write failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 同名整条覆盖(与 `mcp.<name>` 的「重加即替换」语义相同);缺失时新建文件。位置未知 / 文件坏了 ⇒ 拒。 */
export function upsertMcpServerRecord(record: McpServerRecord, log: (line: string) => void = console.warn): McpServerTruthResult {
  const loaded = load(log)
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  const next = [...loaded.servers.filter((s) => s.name !== record.name), canonicalMcpServerRecord(record)]
  return commit(loaded.path, next)
}

/** 删一条;本就不在(含位置未知)= 幂等成功,缺失的文件不会被无谓创建。文件坏了 ⇒ 拒。 */
export function removeMcpServerRecord(name: string, log: (line: string) => void = console.warn): McpServerTruthResult {
  const loaded = load(log)
  if (!loaded.ok) return loaded.unresolved ? { ok: true } : { ok: false, reason: loaded.reason }
  if (!loaded.servers.some((s) => s.name === name)) return { ok: true }
  return commit(loaded.path, loaded.servers.filter((s) => s.name !== name))
}

/** 读一条(启停投影 / 失败补偿的前像用)。位置未知 ⇒ 没有记录;文件坏了 ⇒ ok:false(调用方决定是拒还是当「没有」)。 */
export function findMcpServerRecord(name: string, log: (line: string) => void = console.warn): { ok: true; record: McpServerRecord | undefined } | { ok: false; reason: string } {
  const loaded = load(log)
  if (!loaded.ok) return loaded.unresolved ? { ok: true, record: undefined } : { ok: false, reason: loaded.reason }
  return { ok: true, record: loaded.servers.find((s) => s.name === name) }
}
