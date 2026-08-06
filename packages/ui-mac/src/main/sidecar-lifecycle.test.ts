import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SidecarGenerationState } from "../preload/types"
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
// 锁四件事:
// ① boot 只 **capture**:恰好一处 `bootForkTokenGeneration = getTokenGeneration()`,且在 boot 的
//    spawn 之前(捕获的必须是 fork 继承的那一代);
// ② 提交只在 **health 落定之后**:`void health.wait.then(` 存在,且提交调用就在它的回调里;
// ③ 两条路都经 healthy 门:commit 一律走 commitForkedTokenGeneration,respawn 侧带 healthy 实参;
// ④ 旧的「fork 前直接记账」形状不得复活(`sidecarTokenGeneration = getTokenGeneration()`)。
test("#600 接线锚:boot 的 token 代必须捕获在 fork 前、提交在 health 之后", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  expect(source.split("bootForkTokenGeneration = getTokenGeneration()").length - 1).toBe(1)
  const capture = source.indexOf("bootForkTokenGeneration = getTokenGeneration()")
  const bootSpawn = source.indexOf("const spawning = spawnLocalServer(")
  expect(capture).toBeGreaterThan(-1)
  expect(bootSpawn).toBeGreaterThan(capture)

  const healthGate = source.indexOf("void health.wait.then(")
  expect(healthGate).toBeGreaterThan(bootSpawn)
  expect(source.slice(healthGate, healthGate + 200)).toContain(
    "commitSidecarTokenGeneration(bootForkTokenGeneration, true)",
  )
  expect(source.split("commitSidecarTokenGeneration(bootForkTokenGeneration").length - 1).toBe(1)

  expect(source).toContain("sidecarTokenGeneration = commitForkedTokenGeneration(")
  expect(source).toContain("commitSidecarTokenGeneration(forkTokenGeneration, healthy)")
  expect(source).not.toMatch(/sidecarTokenGeneration = getTokenGeneration\(\)/)
})

test("#858 接线锚:token-only 换血用短收口预算,结构换血与退出保留 graceful", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  expect(source).toContain("async function killSidecar(reason?: SidecarRespawnReason)")
  expect(source).toContain('await current.stop(reason === "token-only" ? "token-rotation" : "graceful")')

  const respawn = source.slice(source.indexOf("const doRespawnSidecar"), source.indexOf("const respawnSidecar"))
  expect(respawn).toContain("await killSidecar(reason)")
  expect(source).toContain("await killSidecar()")
})
