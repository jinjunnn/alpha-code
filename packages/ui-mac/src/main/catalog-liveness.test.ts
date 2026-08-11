import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  armCatalogLiveness,
  decideCatalogLiveness,
  initialCatalogLivenessState,
  probeCatalogMarker,
  type CatalogLivenessSample,
  type CatalogLivenessState,
} from "./catalog-liveness"

// 阈值锚点全部用**独立字面量**(不 import 生产常量当期望值 —— 自指等价链一起改错就一起自洽)。
// 60s / 5s / 3 strikes / 30min 是票面判据的一部分:必须显著大于正常慢 bootstrap(实测 ~16s),
// 远小于被动恢复时延(实测 225s)。改动生产常量必须让这里转红,由 owner 重新裁阈值。
const T0 = 10_000_000
const DEADLINE = 60_000
const STRIKE_DECAY = 30 * 60 * 1000

const notReady: CatalogLivenessSample = { outcome: "engine-not-ready", status: 404 }
const probeTimeout: CatalogLivenessSample = { outcome: "probe-failed", reason: "probe-timeout", message: "t/o" }
const ready: CatalogLivenessSample = { outcome: "ready" }

function armed(now = T0): CatalogLivenessState {
  return armCatalogLiveness(initialCatalogLivenessState(), now)
}

/** 喂一段样本序列,返回最后一次 decision;中途若出现非 none 动作立即返回(测试自会断言)。 */
function feed(state: CatalogLivenessState, samples: Array<{ at: number; sample: CatalogLivenessSample }>) {
  let current = state
  let last = decideCatalogLiveness(samples[0]!.at, samples[0]!.sample, current)
  current = last.state
  for (const step of samples.slice(1)) {
    if (last.action !== "none") return last
    last = decideCatalogLiveness(step.at, step.sample, current)
    current = last.state
  }
  return last
}

describe("catalog-liveness decision", () => {
  test("未武装时任何样本都不产生动作", () => {
    const decision = decideCatalogLiveness(T0, notReady, initialCatalogLivenessState())
    expect(decision.action).toBe("none")
    expect(decision.state.armed).toBe(false)
  })

  test("不误触发:窗口内持续 404 + 探针自身超时混合,一律只记账不裁决", () => {
    // 负向夹具刻意不用退化形状:两类失败交替、贴着 55s(> 实测正常慢 bootstrap 16s 的 3 倍)。
    const steps = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((s, i) => ({
      at: T0 + s * 1000,
      sample: i % 3 === 2 ? probeTimeout : notReady,
    }))
    const decision = feed(armed(), steps)
    expect(decision.action).toBe("none")
    expect(decision.state.armed).toBe(true)
    // 记账分栏:引擎答了没就绪 vs 我们的探测失败,折叠成一个数的实现在这里现形。
    expect(decision.engineNotReady).toBe(8)
    expect(decision.probeFailures).toBe(3)
    expect(decision.probes).toBe(11)
  })

  test("正常慢 bootstrap:大量失败之后、窗口内任一次 ready → confirmed 且永久解除,绝不 respawn", () => {
    const failures = [5, 12, 20, 28, 36, 44, 52].map((s) => ({ at: T0 + s * 1000, sample: notReady }))
    const beforeReady = feed(armed(), failures)
    expect(beforeReady.action).toBe("none")
    const confirmed = decideCatalogLiveness(T0 + 55_000, ready, beforeReady.state)
    expect(confirmed.action).toBe("confirmed")
    expect(confirmed.elapsedMs).toBe(55_000)
    expect(confirmed.state.armed).toBe(false)
    expect(confirmed.state.strikes).toBe(0)
    // 解除后迟到的失败样本不再产生任何动作。
    const late = decideCatalogLiveness(T0 + DEADLINE + 10_000, notReady, confirmed.state)
    expect(late.action).toBe("none")
  })

  test("deadline 前最后一刻的 ready 仍算 confirmed(判据是窗口内有没有成功,不是失败计数)", () => {
    const decision = decideCatalogLiveness(T0 + DEADLINE - 1, ready, armed())
    expect(decision.action).toBe("confirmed")
  })

  test("窗口到期且从未 ready → kill-and-respawn(首次裁决),状态解除、strike=1", () => {
    const failures = [5_000, 20_000, 40_000, DEADLINE].map((ms) => ({ at: T0 + ms, sample: notReady }))
    const decision = feed(armed(), failures)
    expect(decision.action).toBe("kill-and-respawn")
    expect(decision.elapsedMs).toBe(DEADLINE)
    expect(decision.state.armed).toBe(false)
    expect(decision.state.strikes).toBe(1)
    expect(decision.probes).toBe(4)
  })

  test("引擎从没答过(全是我们的探测失败)同样在窗口到期时裁决 —— 引擎卡死也是退化", () => {
    const failures = [10_000, 30_000, DEADLINE].map((ms) => ({ at: T0 + ms, sample: probeTimeout }))
    const decision = feed(armed(), failures)
    expect(decision.action).toBe("kill-and-respawn")
    expect(decision.probeFailures).toBe(3)
    expect(decision.engineNotReady).toBe(0)
  })

  test("30 分钟内第三次裁决 → stop-and-report(不再自动 kill),strike 跨代累计", () => {
    let state = initialCatalogLivenessState()
    const actions: string[] = []
    for (let round = 0; round < 3; round++) {
      const armAt = T0 + round * (DEADLINE + 2_000)
      state = armCatalogLiveness(state, armAt)
      const verdict = decideCatalogLiveness(armAt + DEADLINE, notReady, state)
      actions.push(verdict.action)
      state = verdict.state
    }
    expect(actions).toEqual(["kill-and-respawn", "kill-and-respawn", "stop-and-report"])
    expect(state.strikes).toBe(3)
  })

  test("裁决相隔超过 30 分钟 → strike 衰减,回到 kill-and-respawn 快路径", () => {
    let state = initialCatalogLivenessState()
    state = armCatalogLiveness(state, T0)
    const first = decideCatalogLiveness(T0 + DEADLINE, notReady, state)
    expect(first.action).toBe("kill-and-respawn")
    const armAt = T0 + DEADLINE + STRIKE_DECAY
    state = armCatalogLiveness(first.state, armAt)
    const second = decideCatalogLiveness(armAt + DEADLINE, notReady, state)
    expect(second.action).toBe("kill-and-respawn")
    expect(second.state.strikes).toBe(1)
  })
})

describe("catalog-liveness probe(真执行,fetch 注入)", () => {
  const opts = { url: "http://127.0.0.1:41234", password: "pw-564", directory: "/tmp/alpha-workspace" }

  test("请求形状:打真实 base 的 marker 端点、带 location[directory] 与 Basic auth", async () => {
    let seen: Request | undefined
    await probeCatalogMarker({
      ...opts,
      fetchImpl: async (input) => {
        seen = input as Request
        return new Response(null, { status: 200 })
      },
    })
    expect(seen).toBeDefined()
    const url = new URL(seen!.url)
    expect(url.origin).toBe("http://127.0.0.1:41234")
    // marker id 用独立字面量锚定(就绪的唯一证明,docs/architecture/2026-08-10 勘破),
    // 不 import 生产常量 —— 改错常量必须在这里红。
    expect(url.pathname).toBe("/api/provider/alpha-internal-catalog-ready")
    expect(url.searchParams.get("location[directory]")).toBe("/tmp/alpha-workspace")
    expect(seen!.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:pw-564").toString("base64")}`)
  })

  test("引擎答 2xx → ready", async () => {
    const sample = await probeCatalogMarker({ ...opts, fetchImpl: async () => new Response("{}", { status: 200 }) })
    expect(sample).toEqual({ outcome: "ready" })
  })

  test("引擎真的答了 404(未收敛)→ engine-not-ready 且保留引擎的 status", async () => {
    const sample = await probeCatalogMarker({ ...opts, fetchImpl: async () => new Response("nope", { status: 404 }) })
    expect(sample).toEqual({ outcome: "engine-not-ready", status: 404 })
  })

  test("我们自己的超时 → probe-failed/probe-timeout,不冒充引擎的回答", async () => {
    // fetch 挂死(连 signal 都不尊重),探针必须靠自己的硬上界返回,并把失败记在自己头上。
    const sample = await probeCatalogMarker({
      ...opts,
      timeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => {}),
    })
    expect(sample.outcome).toBe("probe-failed")
    if (sample.outcome === "probe-failed") expect(sample.reason).toBe("probe-timeout")
  })

  test("网络错(fetch reject)→ probe-failed/network", async () => {
    const sample = await probeCatalogMarker({
      ...opts,
      fetchImpl: async () => {
        throw new TypeError("fetch failed")
      },
    })
    expect(sample).toEqual({ outcome: "probe-failed", reason: "network", message: "fetch failed" })
  })

  test("非绝对路径目录拒绝出探(与 prewarm 同款防御)", async () => {
    const sample = await probeCatalogMarker({ ...opts, directory: "relative/dir" })
    expect(sample.outcome).toBe("probe-failed")
  })
})

// #564 接线锚(index.ts 是本仓唯一跑不进单测的文件,生产接线的最后一英里只能锁源码形状;
// 决策行为的真闸门在上面的纯函数用例里)。断言五件事:
// ① 恰好两处武装(boot 终态continuation + respawn 健康线之后),条件形状逐字锁定 ——
//    boot 只在干净 ready 终态武装(injection-failed 不武装),respawn 同判据;
// ② 决策被消费恰好一次(decideCatalogLiveness);
// ③ kill-and-respawn 裁决真的接到 current.kill()(交给既有 self-heal respawn 路径);
// ④ stop-and-report 裁决接到 recoveryService.register(显式恢复,不再自动 kill);
// ⑤ killSidecar 与 handleSidecarExit 都停表(旧代探针不得打在新代身上)。
test("#564 接线锚:看门狗武装/停表/裁决消费必须留在 index.ts 的接线形状里", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  expect(source.split("armCatalogLivenessWatchdog(spawnGen)").length - 1).toBe(2)
  expect(source).toContain('if (terminal === "ready" && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)')
  expect(source).toContain("if (healthy && !injectionFailure && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)")
  expect(source.split("decideCatalogLiveness(").length - 1).toBe(1) // 唯一消费点(import 是裸标识符)

  const armStart = source.indexOf("const armCatalogLivenessWatchdog = (gen: number) => {")
  const armEnd = source.indexOf("CATALOG_LIVENESS_PROBE_INTERVAL_MS)", armStart)
  expect(armStart).toBeGreaterThan(-1)
  expect(armEnd).toBeGreaterThan(armStart)
  const armBody = source.slice(armStart, armEnd)
  expect(armBody).toContain('decision.action === "kill-and-respawn"')
  expect(armBody).toContain("current.kill()")
  expect(armBody).toContain("recoveryService.register")

  const killFn = source.indexOf("async function killSidecar")
  const killFnEnd = source.indexOf("function endSessionGrants")
  expect(source.slice(killFn, killFnEnd)).toContain("stopCatalogLivenessWatchdog()")
  const exitFn = source.indexOf("function handleSidecarExit")
  const exitFnEnd = source.indexOf("function stopEngineRunawayMeter")
  expect(source.slice(exitFn, exitFnEnd)).toContain("stopCatalogLivenessWatchdog()")
})
