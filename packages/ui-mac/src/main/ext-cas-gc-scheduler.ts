// ext-cas-gc-scheduler — REQ-102 #318:CAS GC 生产触发;#367:单轮迁 worker_threads 执行。
//
// 拓扑(Codex 裁决):启动后 5 分钟首跑,此后 24 小时一轮;**单次 schedule → spawn worker →
// await → finally 重新 arm**(不用 setInterval:await 链天然单飞不重叠、异常不中断调度);
// 睡眠错过的周期由下一次 timer 自然补一轮,不追赶(无 catch-up storm,不引入 powerMonitor /
// 持久化 lastRunAt);锁忙 / mark 根损坏 = 本轮如实 log 等下轮,零重试风暴。多实例(prod/beta
// 同机)由共享 CAS 的跨进程 GC 锁串行化,一实例完成整轮、其余 busy-skip,不是漏跑 —— 无需错峰。
// 不提供手动/远端触发 IPC(最小暴露)。
//
// #367(实测 heavy 档单轮 363-499ms、extreme 1.7-2.0s,mark 全量重哈希主导 —— 数据在票面):
// 单轮在 worker_threads 内跑(入口 ext-cas-gc-worker.ts,构建为 out/main/ext-cas-gc-worker.js
// 第三入口),main 只收紧凑摘要。**失败无同步回退**(spawn 失败/worker 异常 = gc-exception +
// 24h rearm;空间回收延迟一轮无害,绝不重新引入主线程阻塞)。stop() 只取消 timer、不
// terminate() 在途 worker;worker 创建即 unref() —— 应用退出不被 GC 轮阻塞,在途轮随进程
// 退出中断 = collector 既有崩溃安全合同(blob 独立无序删,陈旧锁 stale 接管)。
//
// 每轮 seed mark = **本进程当前 package 的 seed lock**(不是同机全部 app 版本 seed 的并集 ——
// 硬约束未要求 union;若未来要求须另行设计 seed-root 聚合)。

import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { getAlphaEnvironment } from "./alpha-environment"
import { CAS_GC_GRACE_MS_DEFAULT, decodeCasGcRoundSummary, defaultCasGcEnvRoots, type CasGcRoundInput, type CasGcRoundSummary } from "./ext-cas-gc"
import { resourcesRoot } from "./ext-fs-installer"

export const CAS_GC_INITIAL_DELAY_MS = 5 * 60 * 1000
export const CAS_GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export type CasGcSchedulerConfig = {
  readonly casBaseRoot: string
  readonly envRoots: readonly string[]
  /** 无条件传入(缺失 = collector 整轮 fail-closed 拒):packaged seed 是强制 mark root,
   *  缺包不得静默退化为「无 seed 根」继续 sweep。 */
  readonly seedLockPaths: readonly string[]
  readonly graceMs: number
  readonly dryRun: boolean
  readonly initialDelayMs: number
  readonly intervalMs: number
}

/** 生产配置的唯一权威取值点(review #364 教训:composition root 缝必须可单测)。
 *  冻结共享 CAS 基根 + dev/prod/beta 三环境根(固定顺序)+ 当前 packaged seed lock(无条件)
 *  + 显式非零 grace + dryRun=false。未初始化环境即抛(fail-fast)。 */
export function productionCasGcConfig(): CasGcSchedulerConfig {
  const casBaseRoot = getAlphaEnvironment().casBaseRoot
  return Object.freeze({
    casBaseRoot,
    envRoots: Object.freeze(defaultCasGcEnvRoots(casBaseRoot)),
    seedLockPaths: Object.freeze([path.join(resourcesRoot(), "extension-seed", "seed.lock.json")]),
    graceMs: CAS_GC_GRACE_MS_DEFAULT,
    dryRun: false,
    initialDelayMs: CAS_GC_INITIAL_DELAY_MS,
    intervalMs: CAS_GC_INTERVAL_MS,
  })
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

/** 一轮 GC 的执行 seam(#367):生产缺省 = 真 worker;测试注入 fake 覆盖调度语义。 */
export type CasGcSpawnRound = (input: CasGcRoundInput) => Promise<CasGcRoundSummary>

/** worker 最小事件面(#385 review r1 F3:可注入 factory,测试确定性驱动任意事件序列)。
 *  载荷统一 unknown:调用侧自行收窄(真 Worker 结构性满足;fake 零断言可构造)。 */
export type CasGcWorkerEvent = "message" | "error" | "messageerror" | "exit"
export type CasGcWorkerLike = {
  on(event: CasGcWorkerEvent, cb: (payload: unknown) => void): void
  unref(): void
  terminate(): Promise<number>
}

/**
 * 在 worker_threads 内跑一轮 GC 并回收紧凑摘要。事件合同(裁决 Q3 + review r1 F1 修订,
 * **exit 为生命周期终态** —— 不依赖任何「message 先于 exit」的顺序假设):
 *   · message:严格解码后**只暂存**,不结算;畸形 / 第二份摘要 = 协议违规,立即失败;
 *   · error / messageerror:失败;
 *   · exit≠0:失败(即使此前已收到合法摘要 —— worker 未以 0 退出即不可信);
 *   · exit=0 ∧ 恰一份合法摘要:成功;exit=0 无摘要:失败。
 * Promise 只结算一次;结算即清理:非 exit 路径结算时 terminate() 残活 worker(review r1
 * F2:失败已上报并将 rearm,旧 worker 不得与后续轮次并存)。创建 → 注册监听 → unref()
 * (unref 只解除 worker 对进程存活的维持,应用退出致本轮中断是明确接受的语义)。
 */
export function spawnCasGcWorkerRound(
  input: CasGcRoundInput,
  entry: URL | string,
  createWorker?: (entry: URL | string, input: CasGcRoundInput) => CasGcWorkerLike,
): Promise<CasGcRoundSummary> {
  return new Promise((resolve, reject) => {
    let worker: CasGcWorkerLike
    try {
      worker = createWorker ? createWorker(entry, input) : new Worker(entry, { workerData: input })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let summary: CasGcRoundSummary | null = null
    let settled = false
    const finish = (fn: () => void, terminateWorker: boolean): void => {
      if (settled) return
      settled = true
      // 协议失败/异常路径:worker 可能仍存活 —— terminate 防与下一轮并存(结果不再关心,吞错)。
      if (terminateWorker) {
        try {
          void worker.terminate().catch(() => {})
        } catch {
          /* terminate 本身抛错 = worker 已死,无事可做 */
        }
      }
      fn()
    }
    worker.on("message", (msg) => {
      if (settled) return
      const decoded = decodeCasGcRoundSummary(msg)
      if (!decoded.ok) {
        finish(() => reject(new Error(`gc worker returned malformed summary: ${decoded.reason}`)), true)
        return
      }
      if (summary !== null) {
        finish(() => reject(new Error("gc worker posted more than one summary — protocol violation")), true)
        return
      }
      summary = decoded.summary
    })
    worker.on("error", (payload) => finish(() => reject(payload instanceof Error ? payload : new Error(String(payload))), true))
    worker.on("messageerror", (payload) =>
      finish(() => reject(new Error(`gc worker message deserialization failed: ${payload instanceof Error ? payload.message : String(payload)}`)), true),
    )
    worker.on("exit", (payload) => {
      // 真 Worker 的 exit 载荷恒为 number;非 number(fake/未来漂移)按失败处理,不猜。
      if (payload !== 0) {
        finish(() => reject(new Error(`gc worker exited with code ${String(payload)}`)), false)
        return
      }
      const got = summary
      if (got === null) {
        finish(() => reject(new Error("gc worker exited without reporting a summary")), false)
        return
      }
      finish(() => resolve(got), false)
    })
    worker.unref()
  })
}

/** 生产 worker 入口(与本模块同目录的第三构建入口;electron.vite main 多入口)。 */
function productionWorkerEntry(): URL {
  return new URL("./ext-cas-gc-worker.js", import.meta.url)
}

/** Manual Settings adapter and periodic scheduler share the exact production worker path. */
export function spawnProductionCasGcWorkerRound(input: CasGcRoundInput): Promise<CasGcRoundSummary> {
  return spawnCasGcWorkerRound(input, productionWorkerEntry())
}

export type CasGcSchedulerDeps = {
  timer?: CasGcSchedulerTimer
  spawnRound?: CasGcSpawnRound
  log?: (event: string, detail: Record<string, unknown>) => void
}

/**
 * 启动 GC 调度。返回幂等 `stop()`(composition root 挂 will-quit);stop 后旧 callback 被意外
 * 调用也不执行、不重新 arm、在途 worker 不 terminate(unref 后随进程退出中断 = 崩溃安全合同)。
 * 每轮写结构化本地摘要(计数不落完整 swept 路径列表;busy-skip 普通语义,fail-closed/异常按
 * loud 处理 —— 缺省 log 即 console.error)。
 */
export function startCasGcScheduler(config: CasGcSchedulerConfig, deps: CasGcSchedulerDeps = {}): { stop(): void } {
  const timer = deps.timer ?? defaultTimer
  const spawnRound = deps.spawnRound ?? spawnProductionCasGcWorkerRound
  const rawLog = deps.log ?? ((event, detail) => console.error(`[cas-gc-scheduler] ${event} ${JSON.stringify(detail)}`))
  // 日志绝不抛(review #366:注入 logger 连抛会逃出 timer callback 打死 main 进程;注入契约不保证不抛)。
  const log: typeof rawLog = (event, detail) => {
    try {
      rawLog(event, detail)
    } catch {
      try {
        console.error(`[cas-gc-scheduler] logger threw while reporting ${event}`)
      } catch {
        /* 最后手段:静默 —— 调度链完整性优先 */
      }
    }
  }
  let stopped = false
  let handle: unknown

  const arm = (delayMs: number): void => {
    if (stopped) return
    handle = timer.schedule(tick, delayMs)
  }

  const logSummary = (summary: CasGcRoundSummary, durationMs: number): void => {
    const outcome = summary.ok
      ? "success"
      : summary.reason && (summary.reason.includes("mutual exclusion") || summary.reason.includes("lock busy"))
        ? "busy-skip"
        : "fail-closed"
    log(`gc-${outcome}`, {
      durationMs,
      marked: summary.marked,
      blobsTotal: summary.blobsTotal,
      sweepable: summary.sweepableCount,
      swept: summary.sweptCount,
      keptByGrace: summary.keptByGrace,
      warningCount: summary.warningCount,
      ...(summary.reason ? { reason: summary.reason } : {}),
    })
  }

  const tick = (): void => {
    if (stopped) return
    const startedAt = Date.now()
    // 复制数组:config 冻结(readonly),线格要求可序列化可变形状;顺带隔离下游变异。
    const input: CasGcRoundInput = {
      casBaseRoot: config.casBaseRoot,
      envRoots: [...config.envRoots],
      seedLockPaths: [...config.seedLockPaths],
      graceMs: config.graceMs,
      dryRun: config.dryRun,
    }
    // spawn 同步抛错也归 gc-exception(裁决 Q4:任何失败等 24h 下轮,无同步回退)。
    void Promise.resolve()
      .then(() => spawnRound(input))
      .then((summary) => logSummary(summary, Date.now() - startedAt))
      .catch((err: unknown) => log("gc-exception", { durationMs: Date.now() - startedAt, error: String(err) }))
      .finally(() => arm(config.intervalMs))
  }

  arm(config.initialDelayMs)
  return {
    stop() {
      stopped = true
      if (handle !== undefined) timer.cancel(handle)
    },
  }
}
