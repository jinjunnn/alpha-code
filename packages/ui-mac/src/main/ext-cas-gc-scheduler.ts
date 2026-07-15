// ext-cas-gc-scheduler — REQ-102 #318:CAS GC 生产触发。
//
// 拓扑(Codex 裁决):启动后 5 分钟首跑,此后 24 小时一轮;**单次 schedule → run → finally 重新
// arm**(不用 setInterval:天然不重叠、run 异常不中断调度);睡眠错过的周期由下一次 timer 自然
// 补一轮,不追赶(无 catch-up storm,不引入 powerMonitor / 持久化 lastRunAt);锁忙 / mark 根损坏
// = 本轮如实 log 等下轮,零重试风暴。多实例(prod/beta 同机)由共享 CAS 的跨进程 GC 锁串行化,
// 一实例完成整轮、其余 busy-skip,不是漏跑 —— 无需错峰。不提供手动/远端触发 IPC(最小暴露)。
//
// 每轮 seed mark = **本进程当前 package 的 seed lock**(不是同机全部 app 版本 seed 的并集 ——
// 硬约束未要求 union;若未来要求须另行设计 seed-root 聚合)。

import * as path from "node:path"
import { getAlphaEnvironment } from "./alpha-environment"
import { CAS_GC_GRACE_MS_DEFAULT, collectCasGarbage, defaultCasGcEnvRoots, type CasGcReport } from "./ext-cas-gc"
import { resourcesRoot } from "./ext-fs-installer"

export const CAS_GC_INITIAL_DELAY_MS = 5 * 60 * 1000
export const CAS_GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export type CasGcSchedulerConfig = {
  casBaseRoot: string
  envRoots: string[]
  /** 无条件传入(缺失 = collector 整轮 fail-closed 拒):packaged seed 是强制 mark root,
   *  缺包不得静默退化为「无 seed 根」继续 sweep。 */
  seedLockPaths: string[]
  graceMs: number
  dryRun: boolean
  initialDelayMs: number
  intervalMs: number
}

/** 生产配置的唯一权威取值点(review #364 教训:composition root 缝必须可单测)。
 *  冻结共享 CAS 基根 + dev/prod/beta 三环境根(固定顺序)+ 当前 packaged seed lock(无条件)
 *  + 显式非零 grace + dryRun=false。未初始化环境即抛(fail-fast)。 */
export function productionCasGcConfig(): CasGcSchedulerConfig {
  const casBaseRoot = getAlphaEnvironment().casBaseRoot
  return {
    casBaseRoot,
    envRoots: defaultCasGcEnvRoots(casBaseRoot),
    seedLockPaths: [path.join(resourcesRoot(), "extension-seed", "seed.lock.json")],
    graceMs: CAS_GC_GRACE_MS_DEFAULT,
    dryRun: false,
    initialDelayMs: CAS_GC_INITIAL_DELAY_MS,
    intervalMs: CAS_GC_INTERVAL_MS,
  }
}

/** 最小计时器接缝(测试注入,保存 callback 手动执行;生产缺省 = setTimeout + unref)。 */
export type CasGcSchedulerTimer = {
  schedule(cb: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const defaultTimer: CasGcSchedulerTimer = {
  schedule: (cb, delayMs) => {
    const t = setTimeout(cb, delayMs)
    t.unref()
    return t
  },
  cancel: (h) => clearTimeout(h as NodeJS.Timeout),
}

export type CasGcSchedulerDeps = {
  timer?: CasGcSchedulerTimer
  run?: typeof collectCasGarbage
  log?: (event: string, detail: Record<string, unknown>) => void
}

/**
 * 启动 GC 调度。返回幂等 `stop()`(composition root 挂 will-quit);stop 后旧 callback 被意外
 * 调用也不执行、不重新 arm。每轮写结构化本地摘要(计数不落完整 swept 路径列表;busy-skip 普通
 * 语义,fail-closed/异常按 loud 处理 —— 缺省 log 即 console.error)。
 */
export function startCasGcScheduler(config: CasGcSchedulerConfig, deps: CasGcSchedulerDeps = {}): { stop(): void } {
  const timer = deps.timer ?? defaultTimer
  const run = deps.run ?? collectCasGarbage
  const log = deps.log ?? ((event, detail) => console.error(`[cas-gc-scheduler] ${event} ${JSON.stringify(detail)}`))
  let stopped = false
  let handle: unknown

  const arm = (delayMs: number): void => {
    if (stopped) return
    handle = timer.schedule(tick, delayMs)
  }

  const logReport = (report: CasGcReport, durationMs: number): void => {
    const outcome = report.ok
      ? "success"
      : report.reason && (report.reason.includes("mutual exclusion") || report.reason.includes("lock busy"))
        ? "busy-skip"
        : "fail-closed"
    log(`gc-${outcome}`, {
      durationMs,
      marked: report.marked,
      blobsTotal: report.blobsTotal,
      sweepable: report.sweepable.length,
      swept: report.swept.length,
      keptByGrace: report.keptByGrace,
      warningCount: report.warnings.length,
      ...(report.reason ? { reason: report.reason } : {}),
    })
  }

  const tick = (): void => {
    if (stopped) return
    const startedAt = Date.now()
    try {
      const report = run(config.casBaseRoot, {
        envRoots: config.envRoots,
        seedLockPaths: config.seedLockPaths,
        graceMs: config.graceMs,
        dryRun: config.dryRun,
      })
      logReport(report, Date.now() - startedAt)
    } catch (err) {
      log("gc-exception", { durationMs: Date.now() - startedAt, error: String(err) })
    } finally {
      arm(config.intervalMs)
    }
  }

  arm(config.initialDelayMs)
  return {
    stop() {
      stopped = true
      if (handle !== undefined) timer.cancel(handle)
    },
  }
}
