import type { SidecarGenerationState } from "../preload/types"

export type SidecarRespawnReason = "token-only" | "structural"

export function shouldReloadRenderer(reason: SidecarRespawnReason): boolean {
  return reason === "structural"
}

/** respawn **自身**的 self-heal 定时器只服务 structural。#600 起 token-only 的重试归 token
 *  rotation latch(封顶低频,createTokenRotationLatch),两处不得双驱同一 pending generation。 */
export function shouldRetryRespawn(reason: SidecarRespawnReason): boolean {
  return reason === "structural"
}

// #600 B1:respawn 一旦发出 recovering,终态必须可达 —— 与 boot 侧 armBootGenerationTerminal
// 同构:从 spawn promise 起就活在普通 promise 链上,三条路(spawn 在返回 health 之前失败 /
// 健康通过 / 健康失败或超时)恰好发布一个 ready|failed。旧接线只在健康通过时发 ready,
// spawn reject 与健康失败都只 return false,generation 永久停在 recovering。
export function armRespawnGenerationTerminal(opts: {
  generation: number
  reason: SidecarRespawnReason
  spawning: Promise<{ health: { wait: Promise<unknown> } }>
  timeoutMs: number
  publish: (state: SidecarGenerationState) => void
  logError: (message: string) => void
}): Promise<boolean> {
  const settle = (healthy: boolean) => {
    opts.publish({
      status: healthy ? "ready" : "failed",
      generation: opts.generation,
      reason: opts.reason,
    })
    return healthy
  }
  return opts.spawning.then(
    async ({ health }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const healthy = await Promise.race([
        health.wait.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), opts.timeoutMs)
        }),
      ])
      clearTimeout(timer)
      // 日志指纹保留自 index.ts 原位。
      if (!healthy) opts.logError("sidecar respawned but health check failed — skipping renderer reload")
      return settle(healthy)
    },
    () => {
      opts.logError("sidecar respawn failed before the health handshake")
      return settle(false)
    },
  )
}

export function mergeRespawnReason(
  current: SidecarRespawnReason | null,
  incoming: SidecarRespawnReason,
): SidecarRespawnReason {
  if (current === "structural" || incoming === "structural") return "structural"
  return "token-only"
}

export function createSidecarRespawnQueue(run: (reason: SidecarRespawnReason) => Promise<boolean>) {
  let active: Promise<boolean> | null = null
  let queued: SidecarRespawnReason | null = null

  const drain = async (reason: SidecarRespawnReason): Promise<boolean> => {
    const healthy = await run(reason)
    const next = queued
    queued = null
    if (!next) return healthy
    return drain(next)
  }

  return (reason: SidecarRespawnReason): Promise<boolean> => {
    if (active) {
      queued = mergeRespawnReason(queued, reason)
      return active
    }
    active = drain(reason).finally(() => {
      active = null
    })
    return active
  }
}
