import type { SidecarGenerationState } from "../preload/types"
export type { SidecarGenerationState } from "../preload/types"

export function createSidecarGenerationState(initial: SidecarGenerationState = {
  status: "recovering",
  generation: 0,
  reason: "boot",
}) {
  let current = initial
  return {
    get: () => current,
    update(next: SidecarGenerationState) {
      current = next
      return current
    },
  }
}

// #577:冷启动的「等健康 → 发终态」必须在普通 promise 链上完成(与 doRespawnSidecar 同构),
// 不能活在 forkChild 被监督 fiber 里 —— 父 fiber 从 serverReady 醒来后毫秒级终止,
// auto-supervision 连带杀死停在健康等待上的子 fiber,ready 从未发出,renderer 永久闩死在
// preload 回放的 recovering 上。健康失败/超时同样发 "failed" 终态,让 consumer 有事实可依。
// 日志语义保留自 index.ts 原位:失败时 "sidecar health check failed",settle 后
// "loading task finished"(「同函数内前有后无」的指纹以后仍可用)。
// #613:健康通过但注入失败 → 终态是 "injection-failed" 而不是 "ready"(仍恰好一个,
// rev2c ③″2-5:注入失败此前不产生任何终态);引擎未就绪(健康失败/超时)支配注入失败 ——
// 引擎都不可达时「配置没注入」不是可行动的事实。
export async function settleBootHealth(opts: {
  generation: number
  healthWait: Promise<unknown>
  timeoutMs: number
  /** #613:sidecar ready IPC 带回的注入失败(spawnLocalServer 透传)。 */
  injectionFailure?: { message: string }
  publish: (state: SidecarGenerationState) => void
  log: (message: string) => void
  logError: (message: string) => void
}): Promise<"ready" | "failed" | "injection-failed"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const healthy = await Promise.race([
    opts.healthWait.then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), opts.timeoutMs)
    }),
  ])
  clearTimeout(timer)
  if (healthy && opts.injectionFailure) {
    opts.logError(`alpha config injection failed — engine is up WITHOUT alpha config: ${opts.injectionFailure.message}`)
    opts.publish({ status: "injection-failed", generation: opts.generation, reason: "boot" })
  } else if (healthy) {
    opts.publish({ status: "ready", generation: opts.generation, reason: "boot" })
  } else {
    opts.logError("sidecar health check failed")
    opts.publish({ status: "failed", generation: opts.generation, reason: "boot" })
  }
  opts.log("loading task finished")
  return healthy ? (opts.injectionFailure ? "injection-failed" : "ready") : "failed"
}

// #577(R1 Blocker1 收口):boot generation 的终态生产者,从 spawn promise 起就活在
// 普通 promise 链上,不受任何 fiber 监督。三条路恰好发布一个终态:
// ① spawn 在返回 health 之前失败(fork 报错 / ready IPC 前退出 / stall reject)→ failed
//   —— 旧接线里这条路直接把启动 Effect 失败到 forwardInitializationFailure,
//   settleBootHealth 根本来不及武装,generation 永久停在 recovering;
// ② 健康通过 → ready;③ 健康失败/超时 → failed(settleBootHealth,含日志指纹)。
export function armBootGenerationTerminal(opts: {
  generation: number
  spawning: Promise<{ health: { wait: Promise<unknown> }; injectionFailure?: { message: string } }>
  timeoutMs: number
  publish: (state: SidecarGenerationState) => void
  log: (message: string) => void
  logError: (message: string) => void
}): Promise<"ready" | "failed" | "injection-failed"> {
  return opts.spawning.then(
    ({ health, injectionFailure }) =>
      settleBootHealth({
        generation: opts.generation,
        healthWait: health.wait,
        timeoutMs: opts.timeoutMs,
        injectionFailure,
        publish: opts.publish,
        log: opts.log,
        logError: opts.logError,
      }),
    () => {
      opts.logError("sidecar spawn failed before health handshake")
      opts.publish({ status: "failed", generation: opts.generation, reason: "boot" })
      opts.log("loading task finished")
      return "failed" as const
    },
  )
}
