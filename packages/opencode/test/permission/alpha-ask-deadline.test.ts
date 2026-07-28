// #668 半场 E —— v1 审批请求的应答期限闸门(alpha 自有测试;ADR-038)。
//
// 这道闸保证的事只有一条,但它是本票的核心:**没有任何应答者时,v1 `Permission.ask`
// 必须在有限时间内以具名失败结束,而不是永远挂着,也不是到点自动放行。**
//
// 判据全是可观测结果,不是源码文本(ADR-037 决策 4):
//   ① 真实挂载生产 `Permission.node + EventV2Bridge.node + InstanceStore.node`,调生产
//      `permission.ask`(与 `packages/opencode/src/session/tools.ts:80-86` 给工具的那条
//      `ctx.ask` 同一个服务、同一个方法);
//   ② 断言 fiber 的 **Exit**:必须 failure。成功退出 = 工具会继续执行 = 到点自动放行,
//      那正是 owner 明禁的形态(候选 D),所以这条断言同时是安全断言;
//   ③ 断言失败值的**身份与文案**:`UnansweredError`(且 instanceof RejectedError,让
//      processor 的 blocked 分支照常生效),文案里必须有用户下一步能做什么;
//   ④ 断言**事件总线**上真的出了一条 reject 回执 —— 呈现面据此收回请求;
//   ⑤ 断言 pending 表被清空 —— 挂起态不残留。
//
// 变异验证(#668 交付时实跑,结论写进 PR):把 `permission/index.ts` 的
// `Effect.timeoutOrElse(...)` 换回裸 `Deferred.await(deferred)` ⇒ 本文件的每条用例都
// 挂到 bun test 超时而转红。

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

/** 期限本身由 env 覆盖压到 300ms —— 被测的是「到点会不会失败」,不是「300 秒有多长」。
 *  生产默认值另有一条独立断言(见文件末),所以这条覆盖不能被当成绕过口:把默认值改成
 *  Infinity 也过不了那条。 */
const TEST_TIMEOUT_MS = 300
process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = String(TEST_TIMEOUT_MS)

const askUnanswered = (sessionID: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      sessionID: SessionID.make(sessionID),
      permission: "external_directory",
      patterns: ["/Users/someone/Downloads/*"],
      metadata: { filepath: "/Users/someone/Downloads/report.csv" },
      always: ["/Users/someone/Downloads/*"],
      ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
    })
  })

it.instance(
  "无人应答的审批请求在期限内以具名失败结束 —— 不挂死、不放行",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askUnanswered("session_deadline_1").pipe(Effect.forkScoped)

      // 到点前后都不允许成功:Fiber.await 拿到的 Exit 必须是 failure。
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS * 20,
          orElse: () => Effect.fail(new Error("permission ask 仍然挂着 —— 期限没有生效")),
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.squash(exit.cause)

      // ③ 具名失败:自己的类型 + 仍是 RejectedError(processor 的 blocked 分支据此生效)。
      expect(error).toBeInstanceOf(Permission.UnansweredError)
      expect(error).toBeInstanceOf(PermissionV1.RejectedError)

      // ③ 文案:说清楚发生了什么、没有放行、下一步能做什么、是哪一个请求。
      const message = (error as Permission.UnansweredError).message
      expect(message).toContain("无人应答")
      expect(message).toContain("没有")
      expect(message).toContain("下一步")
      expect(message).toContain("external_directory")
      expect(message).toContain("/Users/someone/Downloads/*")
      // 不得冒充"用户拒绝"——那是另一件事,会让人去追一个不存在的操作。
      expect(message).not.toContain("The user rejected")

      // ⑤ pending 不残留。
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "期限到达时向事件总线广播 reject 回执 —— 呈现面据此收回请求",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const replied = yield* Deferred.make<{ requestID: string; reply: string }>()
      const asked = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(asked, Effect.succeed(event.data as PermissionV1.Request))
        if (event.type === Permission.Event.Replied.type)
          Deferred.doneUnsafe(replied, Effect.succeed(event.data as { requestID: string; reply: string }))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* askUnanswered("session_deadline_2").pipe(Effect.forkScoped)

      const askedEvent = yield* Deferred.await(asked).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS * 20,
          orElse: () => Effect.fail(new Error("没有收到 permission.asked")),
        }),
      )
      const repliedEvent = yield* Deferred.await(replied).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS * 20,
          orElse: () => Effect.fail(new Error("期限到达后没有收到 permission.replied —— 呈现面会一直挂着那张卡")),
        }),
      )

      expect(repliedEvent.requestID).toBe(askedEvent.id)
      // 回执必须是 reject。这里若出现 "once"/"always",就是到点自动放行 —— 直接红。
      expect(repliedEvent.reply).toBe("reject")

      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "期限不影响正常应答:期限内 reply once 照常放行",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* askUnanswered("session_deadline_3").pipe(Effect.forkScoped)

      const pending = yield* Effect.gen(function* () {
        while (true) {
          const list = yield* permission.list()
          if (list.length === 1) return list
          yield* Effect.sleep("5 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS * 20,
          orElse: () => Effect.fail(new Error("请求没有进入 pending")),
        }),
      )

      yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  { git: true },
)

// 生产默认值断言 —— 防「把默认期限调成极大值,让期限在生产上等于不存在」这种绕过:
// 上面的用例都跑在 env 覆盖下,单靠它们发现不了默认值被改坏。
test("生产默认期限是 5 分钟", () => {
  expect(Permission.ASK_TIMEOUT_MS_DEFAULT).toBe(300_000)
})

// 非法 env 一律回落默认(不是回落到"无期限"):运维手滑写了个 0/负数/NaN,不能把
// fail-closed 的期限变成永久挂起。
test("非法的 ALPHA_PERMISSION_ASK_TIMEOUT_MS 回落到默认值,而不是关掉期限", () => {
  const saved = process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
  try {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = bad
      expect(Permission.resolveAskTimeoutMsForTest()).toBe(Permission.ASK_TIMEOUT_MS_DEFAULT)
    }
    delete process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
    expect(Permission.resolveAskTimeoutMsForTest()).toBe(Permission.ASK_TIMEOUT_MS_DEFAULT)
    process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = "1234"
    expect(Permission.resolveAskTimeoutMsForTest()).toBe(1234)
  } finally {
    if (saved === undefined) delete process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
    else process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = saved
  }
})
