// `#1392`(`#1383` 基线 §四 子票 2)—— 自定义节点真源的**生产读取绑定**:把 `#1391` 的严格读端(custom-provider-truth.ts,
// fs 与日志都靠注入)接到真实的文件系统与「这个进程知道的环境根」上。注入面(alpha-models.ts)、fork 前的密钥物化与
// 出网派生(server.ts)、添加 / 删除(provider-lifecycle.ts)都从这里取记录 —— 一处真源、一处解析,不留镜像。
//
// ── 真源在哪:两条路,同一个答案 ─────────────────────────────────────────────────────
// `<casBaseRoot>/custom-providers/<env>.json`(customProviderTruthPath)。`casBaseRoot` 与 `environment` 在 main 里是
// alpha-environment.ts 冻结快照的两个字段;**sidecar 里没有快照**(utilityProcess 不跑 initAlphaEnvironment),它手里只有
// main 派生给它的 `ALPHA_GLOBAL_DIR` = `<casBaseRoot>/env/<env>`(environmentMutableRoot)。所以第二条路是同一个模块给出的
// **逆映射**(environmentFromMutableRoot):父目录必须叫 `env`、末段必须是 prod | beta | dev,否则不猜 —— 形状不对 ⇒ 「位置未知」
// ⇒ 什么都不派生(fail-closed)并出一行原因。两条路给出的是同一个 baseRoot(快照的 mutableRoot 正是由它拼出来的),
// 判据在 custom-provider-derivation.test.ts。两条路合在 alpha-environment.ts 的 resolveAlphaStateBase(`#1381` 起远程 MCP
// 真源 mcp-server-records.ts 走同一份,不各自抄)。
//
// ── 读不到 ≠ 没有 ─────────────────────────────────────────────────────────────────
// 缺失 = 用户没加过节点,正常,零日志。解析失败 / 形状不对 / 位置未知 ⇒ 返回空清单**并**出一行原因(读端自己那行 + 这里的位置那行),
// 消费者据此什么都不注入、什么都不放行 —— 与「没有记录」在**行为**上相同,在日志上可分辨(`#1387`:静默的失败路径事后
// 无法与「一切正常」区分)。
//
// electron-free、只读(只 import node:fs 的 readFileSync,写盘登记簿 process-fence-write-sites.ts 的扫描器不认它);
// 本文件在 sidecar 的 import 闭包里(alpha-models.ts 引它),**不得** import custom-provider-truth-write.ts
// (custom-provider-truth-write.test.ts 对着生产闭包工具实测)。

import { readFileSync } from "node:fs"
import { resolveAlphaStateBase, type AppEnvironment } from "./alpha-environment"
import { customProviderTruthPath, readCustomProviderTruth, type CustomProviderRecord, type CustomProviderTruthRead } from "./custom-provider-truth"

export type CustomProviderTruthLocation =
  | { ok: true; path: string; casBaseRoot: string; environment: AppEnvironment }
  | { ok: false; reason: string }

/** 真源文件的位置:main 走冻结快照;sidecar(无快照)走 `ALPHA_GLOBAL_DIR` 的逆映射。形状不对 ⇒ ok:false,不猜。 */
export function resolveCustomProviderTruthLocation(): CustomProviderTruthLocation {
  const base = resolveAlphaStateBase("custom-provider truth")
  if (!base.ok) return base
  return { ok: true, path: customProviderTruthPath(base.casBaseRoot, base.environment), casBaseRoot: base.casBaseRoot, environment: base.environment }
}

export type CustomProviderTruthLookup = CustomProviderTruthRead | { ok: false; reason: string; unresolved: true }

/** 完整读取结果(写端要分得清「缺失」与「坏了」);位置未知 ⇒ ok:false + unresolved。每个拒绝分支恰一行日志。 */
export function readCustomProviderTruthFromEnvironment(log: (line: string) => void = defaultLog): CustomProviderTruthLookup {
  const location = resolveCustomProviderTruthLocation()
  if (!location.ok) {
    log(`custom providers: truth location unresolved — ${location.reason}; no custom provider is injected or authorized this generation`)
    return { ok: false, reason: location.reason, unresolved: true }
  }
  return readCustomProviderTruth(location.path, { readFileSync, log })
}

/** 注入面 / 出网 / 密钥物化用的清单:缺失或任何一种「没问出来」都是空清单(原因已由上面那两处出声)。 */
export function readCustomProviderRecords(log: (line: string) => void = defaultLog): CustomProviderRecord[] {
  const read = readCustomProviderTruthFromEnvironment(log)
  return read.ok ? read.providers : []
}

/** sidecar 里没有 electron-log:console.warn 走 utilityProcess 的 stderr,由 main 收进 sidecar 日志;main 侧调用方传自己的 logger。 */
function defaultLog(line: string): void {
  console.warn(line)
}
