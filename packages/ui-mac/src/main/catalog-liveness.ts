// #564 catalog-liveness 看门狗 — pure decision logic(electron-free,单元可测;index.ts 只接线)。
//
// 缺口(真机 run 20260724T091738):sidecar fork 后 1.2s 就发 ready IPC(进程在、/global/health
// 200),但引擎的 catalog/model 服务持续返回 0 模型达 224s,直到 t=225s 一次 respawn 才恢复。
// 既有存活性判据 = 「进程在 + ready IPC 已发」,结构上看不见「引擎活着但治理目录从未收敛」。
//
// 判据(照 docs/architecture/2026-08-10-catalog-readiness-signals.md 的实跑结论):
//   - marker 探针(`/api/provider/alpha-internal-catalog-ready?location[directory]=…`)是目录就绪
//     的**唯一证明**:未收敛恒 404(此时 `/api/model` 照样 200 count 0,所以不能拿 model.list
//     的 200 当就绪),收敛后 200。
//   - 引擎 ready 之后的 DEADLINE 窗口内**从未**观测到一次 marker 200 → 判实例退化,kill 交给
//     既有 self-heal respawn(1s 快路径),把恢复从被动 ~225s 提前到 ~DEADLINE+respawn。
//   - 窗口内任何一次 200 → confirmed,本代永久解除 —— 判据是「窗口内有没有过成功」,不是
//     「连续失败了几次」:正常慢 bootstrap(实测首启收敛 ~16s,T7 样本 marker 到 15.7s 仍 404)
//     只要在窗口内收敛就绝不误伤。
//
// 观测手段自己有盲区(本仓最贵教训):探针**自己的**超时不是引擎的回答。样本按「谁的事实」
// 三分 —— 引擎答了 404(权威的「未收敛」,与 renderer 屏障同判据)、引擎答了协议外 status
// (engine-unclassified,实测目录不存在 ⇒ 确定性 500,不授权 kill)、我们的探测失败
// (probe-failed,probe-timeout/network)分开记账,裁决日志分栏,诊断时才分得出
// 「引擎卡死」「观测面不可用」与「探针环境坏」。
//
// 反复触发的上界:窗口 ≈ SELF_HEAL_RESET_UPTIME_MS ⇒ 退化代每次都把 self-heal 阶梯重置回快路径,
// 没有自己的 strike 上界就是每 ~DEADLINE 一次的无限 kill 循环。镜像 engine-runaway-guard:
// 30min 内累计 3 次裁决 → stop-and-report(留下活着的退化实例 + Recovery incident 交显式恢复,
// 不再自动 kill —— 退化实例还在 serve「正在同步」,杀掉不重启只会更糟)。

export const CATALOG_LIVENESS_PROBE_INTERVAL_MS = 5_000
/** 必须显著大于正常慢 bootstrap(实测 ~16s,≈3.75x 余量),又远小于被动恢复时延(实测 225s)。 */
export const CATALOG_LIVENESS_DEADLINE_MS = 60_000
export const CATALOG_LIVENESS_PROBE_TIMEOUT_MS = 3_000
export const CATALOG_LIVENESS_MAX_STRIKES = 3
export const CATALOG_LIVENESS_STRIKE_DECAY_MS = 30 * 60 * 1000

export type CatalogLivenessSample =
  /** 引擎答了 2xx:治理目录已收敛(marker provider 已提交)。 */
  | { outcome: "ready" }
  /** 引擎**真的答了 404**:目录存在但尚未收敛 —— 这是「未收敛」的**唯一权威表示**
   *  (与 renderer 屏障 model-contract.ts 同判据,readiness 勘破 §3.3:只有 404 /
   *  ProviderNotFoundError 算「尚未收敛」)。 */
  | { outcome: "engine-not-ready"; status: number }
  /** 引擎答了,但 status 在 marker 协议的词汇表之外(500/401/…)。实测(R1 Blocker,
   *  2026-08-11):探针目录不存在时该端点**确定性 500**(`UnknownError`),永不 404/200 ——
   *  这不是「未收敛」,是观测面本身不可用,**不授权到期 kill**。 */
  | { outcome: "engine-unclassified"; status: number }
  /** 引擎没有答 —— 这是**我们这一侧**的事实(自己的超时/网络错),不冒充引擎的回答。 */
  | { outcome: "probe-failed"; reason: "probe-timeout" | "network"; message: string }

export type CatalogLivenessState = {
  armed: boolean
  /** 武装时刻(= 引擎 ready 终态时刻)。deadline 从这里量。 */
  armedAt: number | null
  strikes: number
  lastVerdictAt: number | null
  probes: number
  engineNotReady: number
  engineUnclassified: number
  probeFailures: number
}

export type CatalogLivenessAction =
  | "none"
  | "confirmed"
  | "kill-and-respawn"
  | "stop-and-report"
  /** 窗口到期但**没有一个权威的「未收敛」样本**(引擎在答,答的却全是协议外 status)——
   *  观测面不可用,弃权解除:不 kill、不记 strike。杀一个引擎要凭引擎自己的 404,不凭 500。 */
  | "indeterminate"

export type CatalogLivenessDecision = {
  state: CatalogLivenessState
  action: CatalogLivenessAction
  /** 距武装点的实测时长(confirmed 时 = catalog 可操作时延的 main 侧上界)。未武装时为 0。 */
  elapsedMs: number
  /** 本代累计探针记账(含本次),失败分栏 —— 见文件头「谁的事实」。 */
  probes: number
  engineNotReady: number
  engineUnclassified: number
  probeFailures: number
}

export function initialCatalogLivenessState(): CatalogLivenessState {
  return {
    armed: false,
    armedAt: null,
    strikes: 0,
    lastVerdictAt: null,
    probes: 0,
    engineNotReady: 0,
    engineUnclassified: 0,
    probeFailures: 0,
  }
}

/** 引擎 ready 终态到达时武装。strikes/lastVerdictAt 跨代保留(反无限 kill 循环),计数器归零。 */
export function armCatalogLiveness(state: CatalogLivenessState, now: number): CatalogLivenessState {
  return { ...state, armed: true, armedAt: now, probes: 0, engineNotReady: 0, engineUnclassified: 0, probeFailures: 0 }
}

export function disarmCatalogLiveness(state: CatalogLivenessState): CatalogLivenessState {
  return { ...state, armed: false, armedAt: null }
}

export function resetCatalogLiveness(): CatalogLivenessState {
  return initialCatalogLivenessState()
}

export function decideCatalogLiveness(
  now: number,
  sample: CatalogLivenessSample,
  previous: CatalogLivenessState,
): CatalogLivenessDecision {
  const state =
    previous.lastVerdictAt !== null && now - previous.lastVerdictAt >= CATALOG_LIVENESS_STRIKE_DECAY_MS
      ? { ...previous, strikes: 0, lastVerdictAt: null }
      : previous
  if (!state.armed || state.armedAt === null)
    return {
      state,
      action: "none",
      elapsedMs: 0,
      probes: state.probes,
      engineNotReady: state.engineNotReady,
      engineUnclassified: state.engineUnclassified,
      probeFailures: state.probeFailures,
    }

  const elapsedMs = now - state.armedAt

  if (sample.outcome === "ready") {
    const probes = state.probes + 1
    return {
      state: { ...state, armed: false, armedAt: null, probes: 0, engineNotReady: 0, engineUnclassified: 0, probeFailures: 0 },
      action: "confirmed",
      elapsedMs,
      probes,
      engineNotReady: state.engineNotReady,
      engineUnclassified: state.engineUnclassified,
      probeFailures: state.probeFailures,
    }
  }

  const probes = state.probes + 1
  const engineNotReady = state.engineNotReady + (sample.outcome === "engine-not-ready" ? 1 : 0)
  const engineUnclassified = state.engineUnclassified + (sample.outcome === "engine-unclassified" ? 1 : 0)
  const probeFailures = state.probeFailures + (sample.outcome === "probe-failed" ? 1 : 0)

  // 判据是「窗口内从未成功」,不是「失败了 N 次」——窗口未到期,任何失败形态都只记账。
  if (elapsedMs < CATALOG_LIVENESS_DEADLINE_MS) {
    return {
      state: { ...state, probes, engineNotReady, engineUnclassified, probeFailures },
      action: "none",
      elapsedMs,
      probes,
      engineNotReady,
      engineUnclassified,
      probeFailures,
    }
  }

  // 到期裁决的授权(R1 Blocker):kill 只凭两种**引擎侧**退化证据 ——
  //   ① 窗口内至少一次权威的「未收敛」(404);
  //   ② 引擎整窗一次都没答(全是我们的探测失败 = 引擎卡死也是退化,行为与首版一致)。
  // 引擎在答、答的却全是协议外 status(实测:探针目录不存在 ⇒ 确定性 500)——观测面不可用,
  // 弃权解除,不 kill 不记 strike:否则全新安装(~/Alpha 是 lazy 供给)会在 60s 处杀掉一个
  // 完全健康的引擎,并在三振后弹 Recovery incident。
  const authorized = engineNotReady >= 1 || engineNotReady + engineUnclassified === 0
  if (!authorized) {
    return {
      state: { ...state, armed: false, armedAt: null, probes: 0, engineNotReady: 0, engineUnclassified: 0, probeFailures: 0 },
      action: "indeterminate",
      elapsedMs,
      probes,
      engineNotReady,
      engineUnclassified,
      probeFailures,
    }
  }

  const strikes = Math.min(state.strikes + 1, CATALOG_LIVENESS_MAX_STRIKES)
  return {
    state: {
      armed: false,
      armedAt: null,
      strikes,
      lastVerdictAt: now,
      probes: 0,
      engineNotReady: 0,
      engineUnclassified: 0,
      probeFailures: 0,
    },
    action: strikes < CATALOG_LIVENESS_MAX_STRIKES ? "kill-and-respawn" : "stop-and-report",
    elapsedMs,
    probes,
    engineNotReady,
    engineUnclassified,
    probeFailures,
  }
}

// —— 探针本体(main 侧对引擎的真 HTTP,不是进程内 app.request)——
// URL 形状与 prewarm 单一来源(initialLocationPrewarmRequest,#857/#881 lineage),不自写替身。
import { initialLocationPrewarmRequest } from "./sidecar-location-prewarm"

export type CatalogLivenessProbeOptions = {
  /** 引擎真实 base,如 `http://127.0.0.1:<port>`。 */
  url: string
  password: string
  directory: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function probeCatalogMarker(opts: CatalogLivenessProbeOptions): Promise<CatalogLivenessSample> {
  const timeoutMs = opts.timeoutMs ?? CATALOG_LIVENESS_PROBE_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  const request = initialLocationPrewarmRequest(opts.directory, opts.password, signal, opts.url)
  if (!request)
    return { outcome: "probe-failed", reason: "network", message: `invalid probe directory: ${opts.directory}` }

  // 硬上界不托付给 fetchImpl 是否尊重 signal:自己 race。落选侧的迟到拒绝要在发出处就有人接
  // (readiness 勘破 §3.6 的同款坑),否则每个探针 tick 都可能留一个 unhandledrejection。
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => {})
  const fetching = (opts.fetchImpl ?? fetch)(request)
  fetching.catch(() => {})
  try {
    const res = await Promise.race([fetching, aborted])
    await res.arrayBuffer().catch(() => {})
    if (res.ok) return { outcome: "ready" }
    // 只有 404 是权威的「未收敛」(readiness 勘破 §3.3,与 renderer 屏障同判据);其余 status
    // 是协议外应答(实测:目录不存在 ⇒ 确定性 500),归不可判样本,不授权到期 kill。
    if (res.status === 404) return { outcome: "engine-not-ready", status: res.status }
    return { outcome: "engine-unclassified", status: res.status }
  } catch (error) {
    // AbortSignal.timeout 的 reason 是 name === "TimeoutError" 的 DOMException(与
    // model-contract.ts 的实跑结论同源)。这是**我们的**超时,如实标注,不折进引擎的回答。
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    return {
      outcome: "probe-failed",
      reason: timedOut ? "probe-timeout" : "network",
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
