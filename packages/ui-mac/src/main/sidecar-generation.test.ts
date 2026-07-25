import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { createSidecarGenerationState, settleBootHealth, type SidecarGenerationState } from "./sidecar-generation"

test("sidecar generation snapshot moves from recovering to ready without credentials", () => {
  const state = createSidecarGenerationState()
  expect(state.get()).toEqual({ status: "recovering", generation: 0, reason: "boot" })

  state.update({ status: "recovering", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "recovering", generation: 4, reason: "token-only" })

  state.update({ status: "ready", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "ready", generation: 4, reason: "token-only" })
})

// #577 回归锁:冷启动的健康等待不能活在 forkChild 被监督 fiber 里。父 fiber 从
// serverReady 醒来后没有任何 yield*,毫秒级终止并连带杀死停在健康等待上的子 fiber,
// ready 终态从未发出(47 session 铁证)。本测试镜像 index.ts 启动装载体的接线形状
// (settleBootHealth 在 Deferred.succeed 之前、以普通 promise 链武装,fiber interrupt
// 杀不掉):health 在「serverReady 被消费、父 effect 跑完之后」才 resolve,ready 仍必须发出。
// 改前红(旧接线把健康等待 yield 在子 fiber 里):published 为 [],本用例失败。
test("#577 冷启动:health 在父 effect 结束后才 resolve,仍必须发出 ready 终态(boot)", async () => {
  const published: SidecarGenerationState[] = []
  const logs: string[] = []
  let resolveHealth!: () => void
  const healthWait = new Promise<void>((resolve) => {
    resolveHealth = resolve
  })

  const serverReady = Deferred.makeUnsafe<{ url: string }, unknown>()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        // —— 镜像 index.ts 修复后接线:settleBootHealth 在 Deferred.succeed 前武装 ——
        void settleBootHealth({
          generation: 1,
          healthWait,
          timeoutMs: 2_000,
          publish: (state) => published.push(state),
          log: (message) => logs.push(message),
          logError: (message) => logs.push(message),
        })
        yield* Deferred.succeed(serverReady, { url: "http://127.0.0.1:0" })
      }).pipe(Effect.forkChild)
      // 与 index.ts 相同:父 fiber 等 serverReady,醒来后到结束没有任何 yield*
      yield* Deferred.await(serverReady).pipe(Effect.catch(() => Effect.sync(() => {})))
    }),
  )

  // 父 effect 已跑完(= 生产里父 fiber 已终止),健康探测此刻才完成
  expect(published).toEqual([])
  resolveHealth()
  await new Promise((resolve) => setTimeout(resolve, 50))
  // 恰好一次终态:恰好一个 ready,不得伴随 failed
  expect(published).toEqual([{ status: "ready", generation: 1, reason: "boot" }])
  expect(logs).toContain("loading task finished")
})

// #577:健康失败/超时也必须发出终态(failed),consumer 才有事实可依,
// 而不是永远等下一个事件;两条日志语义保留(失败行 + finished 行)。
test("#577 健康探测失败 → 发出 failed 终态", async () => {
  const published: SidecarGenerationState[] = []
  const logs: string[] = []
  const errors: string[] = []
  const outcome = await settleBootHealth({
    generation: 3,
    healthWait: Promise.reject(new Error("sidecar died")),
    timeoutMs: 2_000,
    publish: (state) => published.push(state),
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  })
  expect(outcome).toBe("failed")
  expect(published).toEqual([{ status: "failed", generation: 3, reason: "boot" }])
  expect(errors).toContain("sidecar health check failed")
  expect(logs).toContain("loading task finished")
})

test("#577 健康探测超时 → 恰好一个 failed 终态,health 迟到 resolve 也不得再发 ready", async () => {
  const published: SidecarGenerationState[] = []
  let resolveHealth!: () => void
  const healthWait = new Promise<void>((resolve) => {
    resolveHealth = resolve
  })
  const outcome = await settleBootHealth({
    generation: 4,
    healthWait,
    timeoutMs: 5,
    publish: (state) => published.push(state),
    log: () => {},
    logError: () => {},
  })
  expect(outcome).toBe("failed")
  expect(published).toEqual([{ status: "failed", generation: 4, reason: "boot" }])
  // 终态恰好一次:超时后健康探测才成功,也不得追加第二个终态
  resolveHealth()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(published).toEqual([{ status: "failed", generation: 4, reason: "boot" }])
})
