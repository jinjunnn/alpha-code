import type { SidecarGenerationState } from "../preload/types"
import { planSelfHeal, type SelfHealPlan, type SelfHealState } from "./sidecar-self-heal"

/**
 * REQ-236 §2.6(`#1562`):引擎重启只由 main 按白名单决定,每一次都带一个具名原因写进
 * `main.sidecar.respawn.fork.start` 的 `reason`。令牌续期**不在**表里 —— 同身份续期热应用凭据文件
 * (`alpha-secret-files.applyPlatformCredentialsHot`),不重启;只有凭据在场性变化或热写失败才以
 * `credential-change` 走结构性重启。单个 MCP 失败、远端目录刷新失败同样不在表里。
 */
export const SIDECAR_RESPAWN_TRIGGERS = [
  "crash-self-heal",
  "log-runaway",
  "catalog-watchdog",
  "identity-change",
  "provider-change",
  "byok-change",
  "connector-change",
  "credential-change",
  // 用户在恢复面 / 输入框状态行点「重启引擎」(§2.6:renderer 只发意图,引擎停摆走 retry-engine)。
  "retry-engine",
] as const
export type SidecarRespawnTrigger = (typeof SIDECAR_RESPAWN_TRIGGERS)[number]

/**
 * REQ-236 `#1562`:一次 `credential-change` 重启没能健康完成(fork 在子进程起来之前失败 / 健康失败 / 20 秒超时)之后,
 * 要不要、多久之后再试。不再试的话:这次 fork 的 syncSecretFiles 已经把在场集合记成新的(server.ts forkedSecrets),
 * 下一次续期判 `applied` 不再重启,而确认只认健康 fork ⇒ 平台态停在 recovering。
 * 走崩溃自愈的同一个阶梯(planSelfHeal:1s → 16s,连续 5 次后放弃;健康运行满 60 秒才清零),所以有界,与崩溃共用一份计数;
 * 崩溃路径(handleSidecarExit)已经排了定时器就不再排第二个。其它 trigger 的失败处理不变。
 */
export function planUnhealthyForkRetry(input: {
  trigger: SidecarRespawnTrigger
  timerArmed: boolean
  selfHeal: SelfHealState
  now: number
}): SelfHealPlan | undefined {
  if (input.trigger !== "credential-change" || input.timerArmed) return undefined
  return planSelfHeal(input.selfHeal, input.now)
}

// #600 B1:respawn 一旦发出 recovering,终态必须可达 —— 与 boot 侧 armBootGenerationTerminal
// 同构:从 spawn promise 起就活在普通 promise 链上,三条路(spawn 在返回 health 之前失败 /
// 健康通过 / 健康失败或超时)恰好发布一个 ready|failed。旧接线只在健康通过时发 ready,
// spawn reject 与健康失败都只 return false,generation 永久停在 recovering。
export function armRespawnGenerationTerminal(opts: {
  generation: number
  spawning: Promise<{ health: { wait: Promise<unknown> }; injectionFailure?: { message: string }; fence?: "applied" }>
  timeoutMs: number
  publish: (state: SidecarGenerationState) => void
  logError: (message: string) => void
}): Promise<boolean> {
  // R1 Major3:终态生产者不得因为 publish 抛出而变成 rejected promise —— 它常常无人 await
  // (spawn reject 路径),rejection 会变成 main 进程的 unhandled rejection。发布失败只降级为一条日志。
  // #613:健康通过但注入失败 → 终态 "injection-failed"(与 boot 侧 settleBootHealth 同构,
  // 同代仍恰好一个终态)。返回值保持「健康线是否通过」:sidecar 真实可达、token 已随 fork
  // 物化({file:} 通道不经注入),reload/token 记账语义不因注入丢失改变 —— 区分呈现归 renderer。
  const settle = (healthy: boolean, injectionFailure?: { message: string }, fence?: "applied") => {
    try {
      opts.publish({
        status: healthy ? (injectionFailure ? "injection-failed" : "ready") : "failed",
        generation: opts.generation,
        // 续期不再重启引擎(`#1562`),于是每一次 respawn 都是结构性的。
        reason: "structural",
        // REQ-159 `#1322`:围栏字段只随引擎在线的终态上车(与 boot 侧 settleBootHealth 同构)。
        ...(healthy && fence ? { fence } : {}),
      })
    } catch (error) {
      opts.logError(`sidecar generation terminal publish failed: ${String(error)}`)
    }
    return healthy
  }
  return opts.spawning.then(
    async ({ health, injectionFailure, fence }) => {
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
      return settle(healthy, injectionFailure, fence)
    },
    () => {
      opts.logError("sidecar respawn failed before the health handshake")
      return settle(false)
    },
  )
}

// 单飞 + 一轮排队。排队期间再来的请求并进同一次 follow-up:它在跑的那一刻读取当刻的 env 与凭据文件,
// 所以一次 fork 覆盖排队期间所有变化;时间线记第一个排队的原因(都是白名单内的具名原因)。
export function createSidecarRespawnQueue(run: (trigger: SidecarRespawnTrigger) => Promise<boolean>) {
  let active: Promise<boolean> | null = null
  let queued: SidecarRespawnTrigger | null = null

  const drain = async (trigger: SidecarRespawnTrigger): Promise<boolean> => {
    const healthy = await run(trigger)
    const next = queued
    queued = null
    if (!next) return healthy
    return drain(next)
  }

  return (trigger: SidecarRespawnTrigger): Promise<boolean> => {
    if (active) {
      queued = queued ?? trigger
      return active
    }
    active = drain(trigger).finally(() => {
      active = null
    })
    return active
  }
}
