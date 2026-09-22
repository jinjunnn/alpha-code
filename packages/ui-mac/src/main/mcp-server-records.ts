// `#1381` —— 远程 MCP 服务器真源的**生产读取绑定**:把严格读端(mcp-server-truth.ts,fs 与日志都靠注入)接到真实的文件系统与
// 「这个进程知道的环境根」上。注入面(alpha-config-injection.ts,sidecar 里)、出网派生(server.ts,main 里)、启停投影
// (ext-install-planner.ts)都从这里取记录 —— 一处真源、一处解析,不留镜像。与 custom-provider-records.ts 同形。
//
// 真源在哪:`<casBaseRoot>/mcp-servers/<env>.json`(mcpServerTruthPath);「状态根 + 环境名」由 alpha-environment.ts 的
// resolveAlphaStateBase 给出(main 走冻结快照;sidecar 走 `ALPHA_GLOBAL_DIR` 的逆映射;形状不对 ⇒ 位置未知 ⇒ 什么都不派生并出一行原因)。
//
// 读不到 ≠ 没有:缺失 = 用户没加过远程连接器,正常,零日志。解析失败 / 形状不对 / 位置未知 ⇒ 返回空清单**并**出一行原因,
// 消费者据此什么都不注入、什么都不放行 —— 与「没有记录」在**行为**上相同,在日志上可分辨(`#1387`)。
//
// electron-free、只读(只 import node:fs 的 readFileSync,写盘登记簿的扫描器不认它);本文件在 sidecar 的 import 闭包里
// (alpha-config-injection.ts 引它),**不得** import mcp-server-truth-write.ts / mcp-server-lifecycle.ts(mcp-server-truth.test.ts 实测)。

import { readFileSync } from "node:fs"
import { resolveAlphaStateBase, type AppEnvironment } from "./alpha-environment"
import { mcpServerTruthPath, readMcpServerTruth, type McpServerRecord, type McpServerTruthRead } from "./mcp-server-truth"

export type McpServerTruthLocation = { ok: true; path: string; casBaseRoot: string; environment: AppEnvironment } | { ok: false; reason: string }

/** 真源文件的位置:main 走冻结快照;sidecar(无快照)走 `ALPHA_GLOBAL_DIR` 的逆映射。形状不对 ⇒ ok:false,不猜。 */
export function resolveMcpServerTruthLocation(): McpServerTruthLocation {
  const base = resolveAlphaStateBase("remote MCP server truth")
  if (!base.ok) return base
  return { ok: true, path: mcpServerTruthPath(base.casBaseRoot, base.environment), casBaseRoot: base.casBaseRoot, environment: base.environment }
}

export type McpServerTruthLookup = McpServerTruthRead | { ok: false; reason: string; unresolved: true }

/** 完整读取结果(写端要分得清「缺失」与「坏了」);位置未知 ⇒ ok:false + unresolved。每个拒绝分支恰一行日志。 */
export function readMcpServerTruthFromEnvironment(log: (line: string) => void = defaultLog): McpServerTruthLookup {
  const location = resolveMcpServerTruthLocation()
  if (!location.ok) {
    log(`remote MCP servers: truth location unresolved — ${location.reason}; no remote MCP server is injected or authorized this generation`)
    return { ok: false, reason: location.reason, unresolved: true }
  }
  return readMcpServerTruth(location.path, { readFileSync, log })
}

/** 注入面 / 出网 / 启停投影用的清单:缺失或任何一种「没问出来」都是空清单(原因已由上面那两处出声)。 */
export function readMcpServerRecords(log: (line: string) => void = defaultLog): McpServerRecord[] {
  const read = readMcpServerTruthFromEnvironment(log)
  return read.ok ? read.servers : []
}

/** sidecar 里没有 electron-log:console.warn 走 utilityProcess 的 stderr,由 main 收进 sidecar 日志;main 侧调用方传自己的 logger。 */
function defaultLog(line: string): void {
  console.warn(line)
}
