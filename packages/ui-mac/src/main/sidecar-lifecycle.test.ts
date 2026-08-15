import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SidecarGenerationState } from "../preload/types"
import type { RenewalResult } from "./alpha-auth"
import { createTokenRotationLatch } from "./auth-renewal"
import { armBootGenerationTerminal } from "./sidecar-generation"
import {
  armRespawnGenerationTerminal,
  commitForkedTokenGeneration,
  createSidecarRespawnQueue,
  mergeRespawnReason,
  shouldReloadRenderer,
  shouldRetryRespawn,
  type SidecarRespawnReason,
} from "./sidecar-lifecycle"

describe("sidecar respawn reasons", () => {
  test("only structural respawns reload the renderer", () => {
    expect(shouldReloadRenderer("token-only")).toBe(false)
    expect(shouldReloadRenderer("structural")).toBe(true)
  })

  // #600:本条曾写作「只有 structural 可以在没有更新 token generation 时重试」,把
  // 「token-only 换血失败即终局」锁成了正确行为。真实语义只剩一条:respawn **自身**的
  // self-heal 定时器只服务 structural —— token-only 的重试归 token rotation latch
  // (封顶低频,见 auth-renewal.test.ts),两处不得双驱同一 pending generation。
  test("the respawn's own self-heal timer stays structural-only; token-only retry belongs to the rotation latch", () => {
    expect(shouldRetryRespawn("token-only")).toBe(false)
    expect(shouldRetryRespawn("structural")).toBe(true)
  })

  test("queued reasons escalate to structural", () => {
    expect(mergeRespawnReason(null, "token-only")).toBe("token-only")
    expect(mergeRespawnReason("token-only", "structural")).toBe("structural")
    expect(mergeRespawnReason("structural", "token-only")).toBe("structural")
  })

  test("coalesced token-only + structural requests run one escalated follow-up", async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const runs: SidecarRespawnReason[] = []
    const request = createSidecarRespawnQueue(async (reason) => {
      runs.push(reason)
      if (runs.length === 1) await first
      return true
    })

    const active = request("token-only")
    request("token-only")
    request("structural")
    release()
    await active
    expect(runs).toEqual(["token-only", "structural"])
  })
})

// #600 B1:respawn 一旦发出 recovering,终态必须可达。旧接线只在健康通过时发 ready ——
// spawn reject 与健康失败/超时都只 return false,generation 永久停在 recovering。
type SpawnResult = { health: { wait: Promise<unknown> } }

describe("respawn generation terminal", () => {
  const collect = () => {
    const published: SidecarGenerationState[] = []
    const errors: string[] = []
    return {
      published,
      errors,
      publish: (state: SidecarGenerationState) => published.push(state),
      logError: (message: string) => errors.push(message),
    }
  }

  test("a spawn that rejects before the health handshake publishes exactly one failed", async () => {
    const sink = collect()
    const settled = await armRespawnGenerationTerminal({
      generation: 7,
      reason: "token-only",
      spawning: Promise.reject(new Error("fork failed")),
      timeoutMs: 50,
      publish: sink.publish,
      logError: sink.logError,
    })

    expect(settled).toBe(false)
    expect(sink.published).toEqual([{ status: "failed", generation: 7, reason: "token-only" }])
    expect(sink.errors).toHaveLength(1)
  })

  test("a rejected health handshake publishes exactly one failed", async () => {
    const sink = collect()
    const settled = await armRespawnGenerationTerminal({
      generation: 8,
      reason: "token-only",
      spawning: Promise.resolve({ health: { wait: Promise.reject(new Error("unhealthy")) } }),
      timeoutMs: 5_000,
      publish: sink.publish,
      logError: sink.logError,
    })

    expect(settled).toBe(false)
    expect(sink.published).toEqual([{ status: "failed", generation: 8, reason: "token-only" }])
  })

  test("a health handshake that never settles times out into exactly one failed", async () => {
    const sink = collect()
    const settled = await armRespawnGenerationTerminal({
      generation: 9,
      reason: "structural",
      spawning: Promise.resolve({ health: { wait: new Promise(() => {}) } }),
      timeoutMs: 10,
      publish: sink.publish,
      logError: sink.logError,
    })

    expect(settled).toBe(false)
    expect(sink.published).toEqual([{ status: "failed", generation: 9, reason: "structural" }])
  })

  // R1 Major3:终态生产者常常无人 await(spawn reject 路径)。publish 抛出时它若变成
  // rejected promise,就是 main 进程的 unhandled rejection,latch 侧也收不到「失败 → 重试」。
  const throwingPublishCases: Array<[string, () => Promise<SpawnResult>]> = [
    ["a spawn rejection", () => Promise.reject(new Error("fork failed"))],
    ["a health rejection", () => Promise.resolve({ health: { wait: Promise.reject(new Error("unhealthy")) } })],
    ["a healthy handshake", () => Promise.resolve({ health: { wait: Promise.resolve("ok") } })],
  ]
  test.each(throwingPublishCases)("a throwing publish on %s still settles instead of rejecting", async (_label, spawning) => {
    const errors: string[] = []
    const settled = await armRespawnGenerationTerminal({
      generation: 11,
      reason: "token-only",
      spawning: spawning(),
      timeoutMs: 50,
      publish: () => {
        throw new Error("renderer gone")
      },
      logError: (message) => errors.push(message),
    })

    expect(typeof settled).toBe("boolean")
    expect(errors.some((message) => message.includes("terminal publish failed"))).toBe(true)
  })

  test("a healthy handshake publishes exactly one ready and never a failed", async () => {
    const sink = collect()
    const settled = await armRespawnGenerationTerminal({
      generation: 10,
      reason: "token-only",
      spawning: Promise.resolve({ health: { wait: Promise.resolve("ok") } }),
      timeoutMs: 10,
      publish: sink.publish,
      logError: sink.logError,
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(true)
    expect(sink.published).toEqual([{ status: "ready", generation: 10, reason: "token-only" }])
    expect(sink.errors).toEqual([])
  })

  // #613 反向闸门(respawn 半场):健康通过但注入失败 → 终态必须是 injection-failed 而非 ready,
  // 且 main 侧 error 出声;返回值保持「健康线通过」(reload/token 记账语义不变,sidecar 真实可达)。
  // 把 settle 的 injectionFailure 分支删掉(回退成一律 ready),本用例转红。
  test("#613 a healthy handshake with an injection failure publishes exactly one injection-failed", async () => {
    const sink = collect()
    const settled = await armRespawnGenerationTerminal({
      generation: 12,
      reason: "structural",
      spawning: Promise.resolve({
        health: { wait: Promise.resolve("ok") },
        injectionFailure: { message: "ENOTDIR: mkdir userdata" },
      }),
      timeoutMs: 10,
      publish: sink.publish,
      logError: sink.logError,
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(true)
    expect(sink.published).toEqual([{ status: "injection-failed", generation: 12, reason: "structural" }])
    expect(sink.errors.some((line) => line.includes("alpha config injection failed") && line.includes("ENOTDIR"))).toBe(
      true,
    )
  })
})

// R3 新 Major:「活着的 sidecar 携带的 token 代」只能由**健康确认**推进,且必须单调。
// boot 路原先在 spawn 之前就记账 ⇒ 健康仍 pending 甚至最终失败时,latch 的 inEffect 路径
// 会据此清掉重试并发布 ready。boot 与 respawn 两条路现在共用这一条规则。
describe("forked token generation commits", () => {
  test("only a healthy fork advances it", () => {
    expect(commitForkedTokenGeneration(1, 3, true)).toBe(3)
    expect(commitForkedTokenGeneration(1, 3, false)).toBe(1)
    expect(commitForkedTokenGeneration(0, 2, false)).toBe(0)
  })

  test("a late boot handshake must not push a newer respawned generation backwards", () => {
    // respawn 已经健康提交了 G5;boot 的健康握手此刻才落定,带着旧的 G2。
    expect(commitForkedTokenGeneration(5, 2, true)).toBe(5)
  })
})

// R4 假闸门 A:上一轮把 boot 改成 capture-then-commit,但**删掉那条接线之后所有测试仍然全绿**
// —— helper 单测只锁纯函数,#577 的五条形状锚只看 armBootGenerationTerminal。生产接线的最后
// 一英里(index.ts 是 electron main,bun test 里 import 不起来)只能锁源码形状,范式沿用 #577 锚。
//
// 锁五件事:
// ① boot 只 **capture**:恰好一处 `const forkTokenGeneration = getTokenGeneration()`,且在 boot
//    spawn 之前(捕获的必须是 fork 继承的那一代);
// ② capture 同时只写 in-flight 去重代,不写已健康代;
// ③ #859:结算**独家**由 boot generation 终态驱动,且该终态带上界(timeoutMs)——
//    三条路(spawn 失败 / 健康通过 / 健康失败或超时)都必然结算,pending 的释放因此有界;
// ④ #859:无上界的结算源不得复活 —— index.ts 不得再直接消费 `health.wait`
//    (server.ts 的 health 只在「探到健康」或「子进程退出」时结束,pollUntilHealthy 无限轮询
//    ⇒ 进程活着但永不健康时它永远 pending),也不得留下绕过终态的 `spawning.catch` 结算;
// ⑤ 仅 healthy settle 经 commitForkedTokenGeneration 提交;旧的 fork 前直接记账不得复活。
// 分类与「这两处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
test("ANCHOR (not a gate): #600/#859 boot token 代先标 in-flight,结算独家挂在有上界的终态上", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  const bootStart = source.indexOf('reason: "boot"')
  const capture = source.indexOf("const forkTokenGeneration = getTokenGeneration()", bootStart)
  const bootSpawn = source.indexOf("const spawning = spawnLocalServer(", capture)
  expect(bootStart).toBeGreaterThan(-1)
  expect(capture).toBeGreaterThan(-1)
  expect(bootSpawn).toBeGreaterThan(capture)
  expect(source.slice(capture, bootSpawn)).toContain("bootForkTokenGeneration = forkTokenGeneration")
  expect(source.slice(capture, bootSpawn)).toContain("pendingBootForkTokenGeneration = forkTokenGeneration")

  // ③ 终态是唯一结算源,并且它带上界。
  const arm = source.indexOf("void armBootGenerationTerminal(", bootSpawn)
  const handoff = source.indexOf("\n      return spawning", arm)
  expect(arm).toBeGreaterThan(bootSpawn)
  expect(handoff).toBeGreaterThan(arm)
  const settlement = source.slice(arm, handoff)
  expect(settlement).toContain("timeoutMs: BOOT_GENERATION_TERMINAL_MS")
  expect(settlement).toContain('settleBootForkTokenGeneration(forkTokenGeneration, terminal !== "failed")')
  expect(settlement).toContain("() => settleBootForkTokenGeneration(forkTokenGeneration, false)")
  expect(source).toMatch(/^const BOOT_GENERATION_TERMINAL_MS = 30_000$/m)

  // ④ 无上界的结算源不得复活:health 既不得被取进 index.ts 的作用域,也不得被直接消费。
  //   (断言写成正则而不是 `not.toContain("health.wait")`,否则解释这件事的注释自己会把它打红。)
  expect(source).not.toMatch(/health\.wait\s*\.\s*then\s*\(/)
  expect(source).not.toMatch(/const \{[^}]*\bhealth\b[^}]*\} = yield\*/)
  expect(source).not.toMatch(/spawning\.catch\(\(\) => settleBootForkTokenGeneration/)

  expect(source).toContain("pendingForkGeneration: () => pendingBootForkTokenGeneration")
  const settle = source.slice(
    source.indexOf("function settleBootForkTokenGeneration("),
    source.indexOf("function recordDanglingSweep("),
  )
  expect(settle).toContain("if (pendingBootForkTokenGeneration !== forked) return")
  // fail-closed 的判定必须落在那条唯一规则上,不得退回 index.ts 里的 `if (healthy)`
  // ——后者跑不进单测,只有源码锚看得见它。
  expect(settle).toContain("commitSidecarTokenGeneration(forked, healthy)")
  expect(settle).not.toMatch(/if \(healthy\)/)
  expect(settle).toContain("pendingBootForkTokenGeneration = 0")
  expect(settle).toContain("void tokenRotation.flush()")

  expect(source).toContain("sidecarTokenGeneration = commitForkedTokenGeneration(")
  expect(source).toContain("commitSidecarTokenGeneration(forkTokenGeneration, healthy)")
  expect(source).not.toMatch(/sidecarTokenGeneration = getTokenGeneration\(\)/)
})

// ── #859 boot 换血竞态 harness ───────────────────────────────────────────────
// 用**生产的两个单元**跑完整条 boot 结算链:
//   armBootGenerationTerminal(sidecar-generation.ts,自带 timeoutMs 上界)
//     → settle(index.ts 的四行 glue,形状由上面那条源码锚逐行钉住)
//     → createTokenRotationLatch(auth-renewal.ts)
// 诚实记账:glue 是这条链上唯一没被直接执行的一环 —— index.ts 顶层 `Effect.runFork(main)`
// 让它在 bun test 里 import 不起来,只能靠源码锚保证形状。其余每一环都是生产代码本身。
// 判据一律用**恰好**(respawns 的确切次数、applied 的确切数组),不写 `≤`、不只断布尔:
// 「宽限内只 fork 一次」这种上限断言写成 `≤1` 就等于没写。
type BootRace = {
  /** boot fork 继承(捕获)的 token 代。 */
  forkGeneration: number
  /** health 线。永不 settle = 「子进程活着但永远探不到健康」(MCP 风暴 / 引擎卡死)。 */
  health: Promise<unknown>
  /** spawn 在 ready 握手之前就失败。 */
  spawnFails?: boolean
  injectionFailure?: { message: string }
  terminalTimeoutMs?: number
}

function runBootRace(race: BootRace) {
  let committed = 0 // = index.ts 的 sidecarTokenGeneration(只由健康确认推进)
  let pending = race.forkGeneration // = index.ts 的 pendingBootForkTokenGeneration
  let respawns = 0
  let nextForkCarries = 0
  const applied: number[] = []
  const published: SidecarGenerationState[] = []
  const flushes: Promise<boolean>[] = []

  const latch = createTokenRotationLatch({
    forkedGeneration: () => committed,
    pendingForkGeneration: () => pending,
    canRespawn: () => true,
    // 换血 = 杀掉旧 sidecar、fork 一个携带被请求那一代的新进程,健康后按同一条规则提交。
    respawn: async () => {
      respawns++
      committed = commitForkedTokenGeneration(committed, nextForkCarries, true)
      return true
    },
    onApplied: (generation) => applied.push(generation),
  })

  // index.ts 的 settle glue。fail-closed 的判定走**生产那条规则**
  // (commitForkedTokenGeneration),不在这里写 `if (healthy)` —— 写了就等于把 AC2 的判定
  // 搬进测试自己的 glue:实测把生产规则改成忽略 healthy,这一整组竞态用例仍然全绿。
  const settle = (forked: number, healthy: boolean) => {
    if (pending !== forked) return
    committed = commitForkedTokenGeneration(committed, forked, healthy)
    pending = 0
    flushes.push(latch.flush())
  }

  const spawning = race.spawnFails
    ? Promise.reject(new Error("fork failed before the ready IPC"))
    : Promise.resolve({ health: { wait: race.health }, injectionFailure: race.injectionFailure })
  const terminal = armBootGenerationTerminal({
    generation: 1,
    spawning,
    timeoutMs: race.terminalTimeoutMs ?? 20,
    publish: (state) => published.push(state),
    log: () => {},
    logError: () => {},
  }).then(
    (outcome) => settle(race.forkGeneration, outcome !== "failed"),
    () => settle(race.forkGeneration, false),
  )

  return {
    published,
    applied,
    latch,
    get respawns() {
      return respawns
    },
    get committed() {
      return committed
    },
    /** 续期落地 ⇒ 请求换血。`carries` = 新 fork 会携带的代(换血成功后提交的就是它)。 */
    request(generation: number, trigger = "boot-grace") {
      nextForkCarries = generation
      return latch.accept({ outcome: "refreshed", generation } satisfies RenewalResult, trigger)
    },
    /** 等终态与它触发的那次 flush 跑完 —— 显式 await 生产 promise 本身,不 sleep 撞运气。 */
    async settled() {
      await terminal
      while (flushes.length) await flushes.shift()
    },
  }
}

describe("#859 boot fork 与 token 换血的竞态", () => {
  // 正向(AC1):宽限内 refreshed —— boot fork 已经带上新代,窗口建立后的 flush 不得再杀它。
  // 五个样本各自独立,判据是**恰好**:respawn 恰好 0 次、applied 恰好一次且是那一代。
  test("宽限内 refreshed:五个样本都只有 boot 一次 fork,token-only 换血恰好 0 次", async () => {
    for (let sample = 1; sample <= 5; sample++) {
      let healthy!: () => void
      const race = runBootRace({
        forkGeneration: 2,
        health: new Promise<void>((resolve) => {
          healthy = resolve
        }),
      })

      // 窗口建立后的那次 flush 落在 health 之前 —— 这正是 #859 的窗口。
      expect(await race.request(2, `boot-grace-${sample}`)).toBe(false)
      expect(await race.latch.flush()).toBe(false)
      expect(race.respawns).toBe(0)
      // fail-closed(AC2):health 未落定之前,这一代绝不能被记成已应用。
      expect(race.committed).toBe(0)
      expect(race.applied).toEqual([])

      healthy()
      await race.settled()
      expect(race.respawns).toBe(0)
      expect(race.committed).toBe(2)
      expect(race.applied).toEqual([2])
      expect(race.published).toEqual([{ status: "ready", generation: 1, reason: "boot" }])
    }
  })

  // fail-closed(AC2):健康线没通过的 fork 不得被标成已应用 —— 它只释放抑制。
  // 反例:让 settle 无条件提交(「干脆在 fork 时就记账」)⇒ 这里 committed 会变成 2、
  // respawn 变成 0,本条与下一条同时转红。
  test("健康失败的 boot fork 不提交代,只释放抑制并换来恰好一次换血", async () => {
    const race = runBootRace({ forkGeneration: 2, health: Promise.reject(new Error("probe refused")) })

    expect(await race.request(2)).toBe(false)
    expect(race.respawns).toBe(0)

    await race.settled()
    expect(race.respawns).toBe(1)
    expect(race.applied).toEqual([2]) // 是新 fork 携带它,不是那个失败的 boot fork
    expect(race.published).toEqual([{ status: "failed", generation: 1, reason: "boot" }])
    // 再多来几次触发也不得变成换血循环。
    expect(await race.latch.flush()).toBe(true)
    expect(race.respawns).toBe(1)
  })

  // 不留终局(AC3)——**本票真正的缺口**:health 结构上可能永不落定
  // (server.ts 只在「探到健康」或「子进程退出」时结束它,pollUntilHealthy 是无限轮询),
  // 而 latch 的 in-flight 抑制分支**不排重试定时器**。结算若挂在 health 上,这一代永远等不到
  // 换血且没有任何定时器会来救 —— 只有把结算挂在带上界的终态上才有界。
  test("health 永不落定:上界到点后仍发生恰好一次换血,不是无定时器终局", async () => {
    const race = runBootRace({ forkGeneration: 2, health: new Promise(() => {}), terminalTimeoutMs: 20 })

    expect(await race.request(2)).toBe(false)
    expect(race.respawns).toBe(0)
    expect(race.committed).toBe(0)
    expect(race.applied).toEqual([])

    await race.settled()
    expect(race.respawns).toBe(1)
    expect(race.committed).toBe(2)
    expect(race.applied).toEqual([2])
    expect(race.published).toEqual([{ status: "failed", generation: 1, reason: "boot" }])
  })

  // 不留终局(AC3):spawn 在 ready 握手前失败 —— 这条路上 health 根本不存在。
  test("spawn 在握手前失败:抑制照样被释放,换血恰好一次", async () => {
    const race = runBootRace({ forkGeneration: 2, health: new Promise(() => {}), spawnFails: true })

    expect(await race.request(2)).toBe(false)
    await race.settled()
    expect(race.respawns).toBe(1)
    expect(race.committed).toBe(2)
    expect(race.published).toEqual([{ status: "failed", generation: 1, reason: "boot" }])
  })

  // 不留终局(AC3)的另一半:boot 之后来了**更新**的代 —— 抑制只对同一代成立。
  // 迟到的 boot 握手不得把已经更新的代推回去(commitForkedTokenGeneration 的单调性)。
  test("boot 在飞时来了更新的代:立刻换血一次,迟到的 boot 握手不再触发第二次", async () => {
    let healthy!: () => void
    const race = runBootRace({
      forkGeneration: 2,
      health: new Promise<void>((resolve) => {
        healthy = resolve
      }),
    })

    expect(await race.request(3, "renewal")).toBe(true)
    expect(race.respawns).toBe(1)
    expect(race.committed).toBe(3)

    healthy()
    await race.settled()
    expect(race.respawns).toBe(1)
    expect(race.committed).toBe(3)
    expect(race.applied).toEqual([3, 3])
  })

  // 注入失败 ≠ 健康线没过:token 随 fork 物化({file:} 通道不经注入),与 respawn 侧
  // armRespawnGenerationTerminal 的返回值语义同构。把它当 failed 处理会白白多杀一次 sidecar。
  test("健康通过但注入失败:仍算这一代已落地,不触发换血", async () => {
    const race = runBootRace({
      forkGeneration: 2,
      health: Promise.resolve(),
      injectionFailure: { message: "ENOTDIR" },
    })

    expect(await race.request(2)).toBe(false)
    await race.settled()
    expect(race.respawns).toBe(0)
    expect(race.committed).toBe(2)
    expect(race.applied).toEqual([2])
    expect(race.published).toEqual([{ status: "injection-failed", generation: 1, reason: "boot" }])
  })
})

test("ANCHOR (not a gate): #858 token-only 换血用短收口预算,结构换血与退出保留 graceful", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  expect(source).toContain("async function killSidecar(reason?: SidecarRespawnReason)")
  expect(source).toContain('await current.stop(reason === "token-only" ? "token-rotation" : "graceful")')

  const respawn = source.slice(source.indexOf("const doRespawnSidecar"), source.indexOf("const respawnSidecar"))
  expect(respawn).toContain("await killSidecar(reason)")
  expect(source).toContain("await killSidecar()")
})
