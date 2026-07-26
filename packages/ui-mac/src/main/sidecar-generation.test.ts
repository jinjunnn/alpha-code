import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect } from "effect"
import {
  armBootGenerationTerminal,
  createSidecarGenerationState,
  settleBootHealth,
  type SidecarGenerationState,
} from "./sidecar-generation"

test("sidecar generation snapshot moves from recovering to ready without credentials", () => {
  const state = createSidecarGenerationState()
  expect(state.get()).toEqual({ status: "recovering", generation: 0, reason: "boot" })

  state.update({ status: "recovering", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "recovering", generation: 4, reason: "token-only" })

  state.update({ status: "ready", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "ready", generation: 4, reason: "token-only" })
})

// #577 回归锁(基线 rev2b ③′-1 行为断言①):冷启动的健康等待不能活在 forkChild
// 被监督 fiber 里。父 fiber 从 serverReady 醒来后没有任何 yield*,毫秒级终止并连带
// 杀死停在健康等待上的子 fiber,ready 终态从未发出(47 session 铁证)。
// 本测试把生产的终态生产者(armBootGenerationTerminal,index.ts 在 spawn factory 内
// 以 void 武装的同一个函数)放进 index.ts 的接线形状(forkChild 子 fiber + 父 fiber
// 无 yield* 终止):health 在「serverReady 被消费、父 effect 跑完之后」才 resolve,
// 仍必须恰好发出一个 ready。改前红(旧接线把健康等待 yield 在子 fiber 里):
// published 为 [],本用例失败(R0 已实跑确认)。
test("#577 冷启动:health 在父 effect 结束后才 resolve,仍必须恰好发出一个 ready 终态(boot)", async () => {
  const published: SidecarGenerationState[] = []
  const logs: string[] = []
  let resolveHealth!: () => void
  const spawning = Promise.resolve({
    health: {
      wait: new Promise<void>((resolve) => {
        resolveHealth = resolve
      }),
    },
  })

  const serverReady = Deferred.makeUnsafe<{ url: string }, unknown>()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        // —— 镜像 index.ts 修复后接线:终态生产者在 spawn factory 内以 void 武装 ——
        yield* Effect.promise(() => {
          void armBootGenerationTerminal({
            generation: 1,
            spawning,
            timeoutMs: 2_000,
            publish: (state) => published.push(state),
            log: (message) => logs.push(message),
            logError: (message) => logs.push(message),
          })
          return spawning
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

// #577 R1 Blocker1:spawnLocalServer 在返回 {listener, health} 之前失败(fork 报错 /
// ready IPC 前退出 / stall reject)时,旧接线里 settleBootHealth 根本来不及武装,
// generation 永久停在 recovering。终态生产者必须从 spawn promise 起就武装:
// spawn reject → 恰好一个 failed。
test("#577 R1 Blocker1:spawn 在 health 之前 reject → 恰好一个 failed 终态", async () => {
  const published: SidecarGenerationState[] = []
  const logs: string[] = []
  const errors: string[] = []
  const outcome = await armBootGenerationTerminal({
    generation: 1,
    spawning: Promise.reject(new Error("sidecar exited before health check passed")),
    timeoutMs: 2_000,
    publish: (state) => published.push(state),
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  })
  expect(outcome).toBe("failed")
  expect(published).toEqual([{ status: "failed", generation: 1, reason: "boot" }])
  expect(errors).toContain("sidecar spawn failed before health handshake")
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

// #613 反向闸门(退出条件 1/3,链条第四环):健康通过但注入失败 → 终态必须是
// "injection-failed" 而不是 "ready",且 main 侧 error 出声。把 settleBootHealth 的
// injectionFailure 分支删掉(回退成一律发 ready),两条断言当场转红。
test("#613 冷启动:健康通过但注入失败 → 恰好一个 injection-failed 终态,main 侧 error 可观测", async () => {
  const published: SidecarGenerationState[] = []
  const errors: string[] = []
  const outcome = await armBootGenerationTerminal({
    generation: 5,
    spawning: Promise.resolve({
      health: { wait: Promise.resolve() },
      injectionFailure: { message: "ENOTDIR: mkdir userdata" },
    }),
    timeoutMs: 2_000,
    publish: (state) => published.push(state),
    log: () => {},
    logError: (message) => errors.push(message),
  })
  expect(outcome).toBe("injection-failed")
  expect(published).toEqual([{ status: "injection-failed", generation: 5, reason: "boot" }])
  expect(errors.some((line) => line.includes("alpha config injection failed") && line.includes("ENOTDIR"))).toBe(true)
})

// #613:引擎未就绪支配注入失败 —— 引擎都不可达时「配置没注入」不是可行动的事实,
// 终态仍是恰好一个 failed(不得发出第二个终态,也不得把 failed 换成 injection-failed)。
test("#613 冷启动:健康失败 + 注入失败 → 仍是恰好一个 failed 终态", async () => {
  const published: SidecarGenerationState[] = []
  const outcome = await armBootGenerationTerminal({
    generation: 6,
    spawning: Promise.resolve({
      health: { wait: Promise.reject(new Error("sidecar died")) },
      injectionFailure: { message: "ENOTDIR: mkdir userdata" },
    }),
    timeoutMs: 2_000,
    publish: (state) => published.push(state),
    log: () => {},
    logError: () => {},
  })
  expect(outcome).toBe("failed")
  expect(published).toEqual([{ status: "failed", generation: 6, reason: "boot" }])
})

// #577 接线锚(R1 加固 + R2 位置加固:上面的 fiber 用例锁的是被 index.ts 调用的生产
// 函数在监督生命周期下的行为;index.ts 本体是 electron main,无法在 bun test 里
// import 执行,生产接线的最后一英里只能锁源码形状)。
//
// R2 指出仅锁「detached + 恰好一次 + 无 yield*」不足以闭合假闸门:把
// `void armBootGenerationTerminal(...)` 保留为 detached 调用、但挪到
// `yield* Effect.promise(...)` 成功返回之后,三条形状断言仍全部满足,而 spawn reject
// 时 fiber 在抵达 arm 之前就失败了 —— generation 又永久只剩 recovering,测试却绿。
// 故必须额外锁住位置关系:武装点在 spawn promise 创建之后、在它被交回 fiber 之前。
//
// 断言五件事:
// ① 恰好一次 `void armBootGenerationTerminal(` 武装终态生产者(detached);
// ② 它从未被 yield* 进任何 fiber(那会把终态重新放回监督死区);
// ③ index.ts 不再直接调用 settleBootHealth(终态生产一律经 armBootGenerationTerminal,
//    避免有人绕过 spawn-失败分支);
// ④ 位置:spawn promise 创建 → 武装 → 交回 fiber(`return spawning`),顺序不得错;
// ⑤ 武装调用确实拿到了那个 spawn promise(`spawning,`),而不是别的东西。
test("#577 接线锚:终态生产者必须在 spawn promise 交回 fiber 之前 detached 武装", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  expect(source.split("void armBootGenerationTerminal(").length - 1).toBe(1)
  expect(source).not.toMatch(/yield\*\s*armBootGenerationTerminal/)
  expect(source).not.toMatch(/settleBootHealth\s*\(/)

  // boot 路的 spawn(respawn 路另有一处,indexOf 从 0 起自然取到 boot 这一处)
  const spawn = source.indexOf("const spawning = spawnLocalServer(")
  const arm = source.indexOf("\n      void armBootGenerationTerminal(", spawn)
  const handoff = source.indexOf("\n      return spawning", spawn)

  expect(spawn).toBeGreaterThan(-1)
  expect(arm).toBeGreaterThan(spawn)
  expect(handoff).toBeGreaterThan(arm)
  expect(source.slice(arm, handoff)).toContain("spawning,")
})
