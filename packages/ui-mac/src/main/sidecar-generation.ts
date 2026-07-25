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
export async function settleBootHealth(opts: {
  generation: number
  healthWait: Promise<unknown>
  timeoutMs: number
  publish: (state: SidecarGenerationState) => void
  log: (message: string) => void
  logError: (message: string) => void
}): Promise<"ready" | "failed"> {
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
  if (healthy) {
    opts.publish({ status: "ready", generation: opts.generation, reason: "boot" })
  } else {
    opts.logError("sidecar health check failed")
    opts.publish({ status: "failed", generation: opts.generation, reason: "boot" })
  }
  opts.log("loading task finished")
  return healthy ? "ready" : "failed"
}
