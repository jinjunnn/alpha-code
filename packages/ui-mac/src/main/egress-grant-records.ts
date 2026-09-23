// `#1412` —— 用户批准的出网目的地真源的**生产读写绑定**:把严格读端(egress-grant-truth.ts)与原子写端
// (egress-grant-truth-write.ts)接到真实的文件系统与「这个进程知道的环境根」上。与 mcp-server-records.ts 同形。
//
// 真源在哪:`<casBaseRoot>/egress-grants/<env>.json`;「状态根 + 环境名」由 alpha-environment.ts 的
// resolveAlphaStateBase 给出(main 走冻结快照;形状不对 ⇒ 位置未知 ⇒ 什么都不装载、什么都不落盘,并出一行原因)。
//
// 读不到 ≠ 没有:缺失 = 用户没批准过任何目的地(绝大多数用户的正常状态,零日志)。解析失败 / 形状不对 /
// 位置未知 ⇒ 空清单**并**出一行原因,消费者据此什么都不放行 —— 与「没有记录」在**行为**上相同(仍 403),
// 在日志上可分辨(`#1387`)。
//
// 本文件 import 写端,因此**不得**进 sidecar 的 import 闭包(判据同写端)。只有 main 调它。

import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { resolveAlphaStateBase, type AppEnvironment } from "./alpha-environment"
import { egressGrantTruthPath, readEgressGrantTruth, type EgressGrantRecord } from "./egress-grant-truth"
import { writeEgressGrantTruth } from "./egress-grant-truth-write"

export type EgressGrantTruthLocation = { ok: true; path: string; casBaseRoot: string; environment: AppEnvironment } | { ok: false; reason: string }

/** 真源文件的位置。形状不对 ⇒ ok:false,不猜。 */
export function resolveEgressGrantTruthLocation(): EgressGrantTruthLocation {
  const base = resolveAlphaStateBase("egress grant truth")
  if (!base.ok) return base
  return { ok: true, path: egressGrantTruthPath(base.casBaseRoot, base.environment), casBaseRoot: base.casBaseRoot, environment: base.environment }
}

/** 装载用的清单:缺失或任何一种「没问出来」都是空清单(原因已出声)。 */
export function readEgressGrantRecords(log: (line: string) => void = defaultLog): EgressGrantRecord[] {
  const location = resolveEgressGrantTruthLocation()
  if (!location.ok) {
    log(`egress grants: truth location unresolved — ${location.reason}; no user-approved destination is authorized this run`)
    return []
  }
  const read = readEgressGrantTruth(location.path, { readFileSync, log })
  return read.ok ? read.grants : []
}

/**
 * 追加一条批准并落盘(用户勾了「记住」时走这条)。整份重写,`host:port` 去重(后写的赢)。
 * 位置未知 / 现有文件读不出来 ⇒ **不落盘**并出一行原因:宁可下次再问一遍,也不拿一份读不懂的文件覆盖。
 */
export function persistEgressGrantRecord(grant: { host: string; port: number }, at: string, log: (line: string) => void = defaultLog): void {
  const location = resolveEgressGrantTruthLocation()
  if (!location.ok) {
    log(`egress grants: cannot remember ${grant.host}:${grant.port} — truth location unresolved (${location.reason}); it stays approved for this run only`)
    return
  }
  const read = readEgressGrantTruth(location.path, { readFileSync, log })
  if (!read.ok) {
    log(`egress grants: cannot remember ${grant.host}:${grant.port} — the existing truth file is unreadable; it stays approved for this run only`)
    return
  }
  const key = `${grant.host.toLowerCase()}:${grant.port}`
  const next: EgressGrantRecord[] = [...read.grants.filter((g) => `${g.host.toLowerCase()}:${g.port}` !== key), { host: grant.host.toLowerCase(), port: grant.port, at }]
  writeEgressGrantTruth(location.path, next, { mkdirSync, writeFileSync, renameSync, rmSync })
  log(`egress grants: remembered ${grant.host}:${grant.port} in ${location.path} — the engine tree may reach it until you remove that record`)
}

function defaultLog(line: string): void {
  console.warn(line)
}
