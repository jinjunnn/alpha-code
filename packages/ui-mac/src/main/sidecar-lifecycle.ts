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

// 「活着的 sidecar 携带的 token 代」的唯一推进规则(R3 新 Major:boot 路原先在 spawn 之前就
// 记账,健康握手还没通过甚至最终失败时,latch 的 inEffect 路径就会据此报 applied 并发 ready)。
//  - 只有**健康确认**才提交 —— fork 出去、健康未过,不算数;
//  - 单调 —— boot 的健康握手可能晚于一次 respawn 落定,迟到的旧代不得把它推回去。
export function commitForkedTokenGeneration(current: number, forked: number, healthy: boolean): number {
  return healthy ? Math.max(current, forked) : current
}

// #600 B1:respawn 一旦发出 recovering,终态必须可达 —— 与 boot 侧 armBootGenerationTerminal
// 同构:从 spawn promise 起就活在普通 promise 链上,三条路(spawn 在返回 health 之前失败 /
// 健康通过 / 健康失败或超时)恰好发布一个 ready|failed。旧接线只在健康通过时发 ready,
// spawn reject 与健康失败都只 return false,generation 永久停在 recovering。
export function armRespawnGenerationTerminal(opts: {
  generation: number
  reason: SidecarRespawnReason
  spawning: Promise<{ health: { wait: Promise<unknown> }; injectionFailure?: { message: string } }>
  timeoutMs: number
  publish: (state: SidecarGenerationState) => void
  logError: (message: string) => void
}): Promise<boolean> {
  // R1 Major3:终态生产者不得因为 publish 抛出而变成 rejected promise —— 它常常无人 await
  // (spawn reject 路径),rejection 会变成 main 进程的 unhandled rejection;而 latch 侧收到
  // rejected respawn 就不会武装重试(无定时器终局)。发布失败只降级为一条日志。
  // #613:健康通过但注入失败 → 终态 "injection-failed"(与 boot 侧 settleBootHealth 同构,
  // 同代仍恰好一个终态)。返回值保持「健康线是否通过」:sidecar 真实可达、token 已随 fork
  // 物化({file:} 通道不经注入),reload/token 记账语义不因注入丢失改变 —— 区分呈现归 renderer。
  const settle = (healthy: boolean, injectionFailure?: { message: string }) => {
    try {
      opts.publish({
        status: healthy ? (injectionFailure ? "injection-failed" : "ready") : "failed",
        generation: opts.generation,
        reason: opts.reason,
      })
    } catch (error) {
      opts.logError(`sidecar generation terminal publish failed: ${String(error)}`)
    }
    return healthy
  }
  return opts.spawning.then(
    async ({ health, injectionFailure }) => {
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
      else if (injectionFailure)
        opts.logError(
          `alpha config injection failed — sidecar respawned WITHOUT alpha config: ${injectionFailure.message}`,
        )
      return settle(healthy, injectionFailure)
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
