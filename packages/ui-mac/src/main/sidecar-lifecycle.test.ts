import { describe, expect, test } from "bun:test"
import type { SidecarGenerationState } from "../preload/types"
import {
  armRespawnGenerationTerminal,
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
})
