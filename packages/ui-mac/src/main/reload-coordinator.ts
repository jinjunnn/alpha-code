// REQ-234 `#1529`(基线 §2.6)—— main 侧的重载**请求方与记录方**。执行者只有一个:ext 进程内的调度器(C3)。
//
// main 在这里做三件事,不多:
//   · 分配 generation、记下「谁、为什么、对哪个作用域」要重载,经 parentPort 发 `alpha.reload.request`;
//   · 收 `alpha.reload.report`,记结局(reloaded / failed / waiting);
//   · sidecar ready 时把仍未 reloaded 的 generation **原样重发**(幂等;ext 的队列随进程消失)。
// 状态不持久化:main 重启 ⇒ 记录清空,hub-view 的即时核验说了算(§2.5)。
//
// 「待重载」的原因从这里取(hub-view 只在**即时核验没过**时才问):
//   覆盖该目录的最新在途 generation —— 没有报告 / waiting ⇒ reload-waiting;failed ⇒ reload-failed。
//   覆盖 = global 覆盖一切目录;{ directory } 只覆盖同一目录。
//   某个 generation 报 reloaded ⇒ 它与它之前、被它覆盖的在途 generation 一并退场(一次成功的 dispose
//   会装载当时盘上的一切,之前排的请求的目的已经达到)。

import {
  buildReloadRequest,
  type HubStateReason,
  type ReloadItem,
  type ReloadOutcome,
  type ReloadReportMessage,
  type ReloadRequestMessage,
  type ReloadScope,
} from "./alpha-sidecar-messages"

export type ReloadRequestInput = { scope: ReloadScope; items: ReloadItem[]; reason: string; force?: boolean }

type GenerationRecord = {
  generation: number
  scope: ReloadScope
  items: ReloadItem[]
  reason: string
  force: boolean
  requestedAt: number
  reportedAt?: number
  outcome?: ReloadOutcome
  error?: string
}

export type ReloadCoordinator = {
  /** 记一笔并(sidecar 在时)立即发出。返回分配的 generation。 */
  request(input: ReloadRequestInput): { generation: number }
  /** ext 的报告。未知 generation ⇒ 记一行、忽略。 */
  receiveReport(report: ReloadReportMessage): void
  /** sidecar ready:接上发送口,重发全部在途 generation。返回**这一次**连接的断开函数(sidecar 退出时调):
   *  在途的保留(下一次 attach 重发),它们已收到的 waiting/failed 作废;晚到的旧连接断开不影响新连接。 */
  attach(post: (message: ReloadRequestMessage) => void): (reason: string) => void
  /** 覆盖 `directory` 的在途重载给出的原因;没有在途 ⇒ undefined。 */
  pendingFor(directory: string): HubStateReason | undefined
}

function covers(scope: ReloadScope, directory: string): boolean {
  return scope === "global" || scope.directory === directory
}

function coversScope(outer: ReloadScope, inner: ReloadScope): boolean {
  return outer === "global" || (inner !== "global" && inner.directory === outer.directory)
}

function describeScope(scope: ReloadScope): string {
  return scope === "global" ? "global" : `directory ${scope.directory}`
}

export function createReloadCoordinator(deps: {
  log: (line: string) => void
  /** 任何会改变「待重载」原因的事件之后调用(hub-view 据此推 `ext-hub-view-changed`)。 */
  onChange: () => void
  now?: () => number
}): ReloadCoordinator {
  const now = deps.now ?? Date.now
  const inFlight = new Map<number, GenerationRecord>()
  let seq = 0
  let post: ((message: ReloadRequestMessage) => void) | undefined
  let detachedBecause: string | undefined = "engine not running"

  const send = (record: GenerationRecord) => {
    if (!post) return
    try {
      post(
        buildReloadRequest({
          generation: record.generation,
          scope: record.scope,
          items: record.items,
          reason: record.reason,
          force: record.force,
        }),
      )
    } catch (error) {
      deps.log(`reload: generation ${record.generation} could not be posted to the engine: ${String(error)}`)
    }
  }

  return {
    request(input) {
      const record: GenerationRecord = {
        generation: ++seq,
        scope: input.scope,
        items: input.items,
        reason: input.reason,
        force: input.force === true,
        requestedAt: now(),
      }
      inFlight.set(record.generation, record)
      deps.log(
        `reload: generation ${record.generation} requested (${describeScope(record.scope)}${record.force ? ", force" : ""}) — ${record.reason}`,
      )
      send(record)
      deps.onChange()
      return { generation: record.generation }
    },

    receiveReport(report) {
      const record = inFlight.get(report.generation)
      if (!record) {
        deps.log(`reload: report for unknown generation ${report.generation} (${report.outcome}) ignored`)
        return
      }
      record.reportedAt = now()
      record.outcome = report.outcome
      record.error = report.error
      deps.log(
        `reload: generation ${record.generation} reported ${report.outcome}` +
          (report.error ? ` — ${report.error}` : "") +
          ` after ${record.reportedAt - record.requestedAt}ms`,
      )
      if (report.outcome === "reloaded") {
        for (const other of [...inFlight.values()])
          if (other.generation <= record.generation && coversScope(record.scope, other.scope)) inFlight.delete(other.generation)
      }
      deps.onChange()
    },

    attach(next) {
      post = next
      detachedBecause = undefined
      for (const record of [...inFlight.values()].sort((a, b) => a.generation - b.generation)) send(record)
      if (inFlight.size > 0) deps.log(`reload: engine ready — re-sent ${inFlight.size} pending generation(s)`)
      deps.onChange()
      return (reason) => {
        if (post !== next) return
        post = undefined
        detachedBecause = reason
        for (const record of inFlight.values()) {
          delete record.outcome
          delete record.error
          delete record.reportedAt
        }
        deps.onChange()
      }
    },

    pendingFor(directory) {
      let latest: GenerationRecord | undefined
      for (const record of inFlight.values())
        if (covers(record.scope, directory) && (!latest || record.generation > latest.generation)) latest = record
      if (!latest) return
      if (latest.outcome === "failed") return { code: "reload-failed", ...(latest.error ? { detail: latest.error } : {}) }
      if (latest.outcome === "waiting") return { code: "reload-waiting", ...(latest.error ? { detail: latest.error } : {}) }
      return { code: "reload-waiting", detail: detachedBecause ?? "queued" }
    },
  }
}
