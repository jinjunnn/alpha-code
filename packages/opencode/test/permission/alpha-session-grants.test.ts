// #1128(REQ-131 CODE)—— v1 Permission 引擎的 session grant 语义闸(#724 §4.4/§4.5;#1122 B9/B13)。
//
// 判据全部走**生产引擎**:真实挂载 `Permission.node + EventV2Bridge.node + InstanceStore.node`,
// 调生产 `permission.ask` / `permission.reply`(与 `session/tools.ts` 给工具的 `ctx.ask`
// 同一个服务、同一个方法)。不测内层纯函数 —— 落在合成层的绕过必须在这里翻红。
//
// 钉住的保证(每一条都问过「一个错误实现能不能满足它」):
//   ① deny 不可被 session grant 突破(B9):先 always 再收紧成 deny,ask 必须以
//      DeniedError 失败 —— 断言的是**失败类型**,不是布尔;把 grant 拼回 ruleset 之后
//      取 findLast 的旧实现在此当场红。
//   ② always 只在当前 session 生效(B13):A 会话的批条对 B 会话**不可见** ——
//      B 的同 subject ask 必须真的进 pending(以 `list()` 里出现 B 的请求为证),
//      而不是「没弹窗」(把 ask 整段删掉也没弹窗)。
//   ③ always discharge ask(#1128 退出条件):同 session 同 subject 第二次 ask
//      直接返回,pending 全程为空 —— 断言「从没进过待批队列」,不是「最终没挂着」。
//   ④ once 不落账:同 subject 第二次必须重新进 pending。
//   ⑤ `clearGrants`(§5 切账户/登出的清账口):清了指定会话的批条之后必须重新问;
//      别的会话的批条不受影响。
//
// 变异验证(交付时实跑,结论写进 PR):
//   · 把 ask 里的 `evaluate(request.permission, pattern, ruleset)` 换回
//     `evaluate(..., ruleset, grantsAsRules)` ⇒ ①红;
//   · 把 grant 的 `sessionID` 匹配去掉(退回 instance 级)⇒ ②⑤红。
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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

/** 期望值手写字面量 —— 不从 canonicalToolIdentity 导出(自指等价链)。 */
const SUBJECT = "mcp:policy:paid_action"

const ASK_RULESET: PermissionV1.Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: SUBJECT, pattern: "*", action: "ask" },
]
const DENY_RULESET: PermissionV1.Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: SUBJECT, pattern: "*", action: "deny" },
]

const askSubject = (sessionID: string, ruleset: PermissionV1.Rule[]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      sessionID: SessionID.make(sessionID),
      permission: SUBJECT,
      patterns: ["*"],
      metadata: {},
      always: ["*"],
      ruleset,
    })
  })

/** 轮询生产 `Permission.list()` 直到出现待批请求(审批面读的就是它)。 */
const awaitPending = Effect.fn("alphaGrants.awaitPending")(function* (rounds = 100) {
  const permission = yield* Permission.Service
  for (let i = 0; i < rounds; i += 1) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending
    yield* Effect.sleep("10 millis")
  }
  return yield* permission.list()
})

/** 走完一轮「ask → 进 pending → 用户应答」,返回 ask fiber 的 Exit。 */
const askAndReply = (sessionID: string, ruleset: PermissionV1.Rule[], reply: PermissionV1.Reply) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* askSubject(sessionID, ruleset).pipe(Effect.forkScoped)
    const pending = yield* awaitPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.permission).toBe(SUBJECT)
    yield* permission.reply({ requestID: pending[0]!.id, reply })
    return yield* Fiber.await(fiber)
  })

it.instance(
  "① B9:always 之后把同一 subject 收紧成 deny ⇒ ask 以 DeniedError 失败,批条压不过 deny",
  () =>
    Effect.gen(function* () {
      const first = yield* askAndReply("session_b9", ASK_RULESET, "always")
      expect(Exit.isSuccess(first)).toBe(true)

      const denied = yield* askSubject("session_b9", DENY_RULESET).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (!Exit.isFailure(denied)) return
      // 失败**类型**必须是 DeniedError —— 「ok 是 false」不够(reason 换了也是 false)。
      expect(Cause.squash(denied.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      // deny 判定后不得残留 pending(deny 不是「挂起待批」)。
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "② B13:会话 A 点 always ⇒ 会话 B 同 subject 必须重新进待批队列,批条不跨会话",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const first = yield* askAndReply("session_b13_a", ASK_RULESET, "always")
      expect(Exit.isSuccess(first)).toBe(true)

      const fiberB = yield* askSubject("session_b13_b", ASK_RULESET).pipe(Effect.forkScoped)
      const pendingB = yield* awaitPending()
      // 判据是「B 的请求真的出现在待批队列」,不是「没直接放行」。
      expect(pendingB.map((item) => item.sessionID)).toContain(SessionID.make("session_b13_b"))
      yield* permission.reply({ requestID: pendingB[0]!.id, reply: "reject" })
      const exitB = yield* Fiber.await(fiberB)
      expect(Exit.isFailure(exitB)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "③ always discharge ask:同 session 同 subject 第二次直接返回,从没进过待批队列",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const first = yield* askAndReply("session_discharge", ASK_RULESET, "always")
      expect(Exit.isSuccess(first)).toBe(true)

      // 第二次:同步完成(不 fork —— 若引擎又去问,这里会挂到测试超时而红)。
      yield* askSubject("session_discharge", ASK_RULESET)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "④ once 不落账:同 subject 第二次必须重新进待批队列",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const first = yield* askAndReply("session_once", ASK_RULESET, "once")
      expect(Exit.isSuccess(first)).toBe(true)

      const second = yield* askSubject("session_once", ASK_RULESET).pipe(Effect.forkScoped)
      const pending = yield* awaitPending()
      expect(pending.length).toBe(1)
      expect(pending[0]!.sessionID).toBe(SessionID.make("session_once"))
      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      const exit = yield* Fiber.await(second)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "⑤ clearGrants:清掉本会话批条后必须重新问;只清指定会话,别的会话批条仍在",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      expect(Exit.isSuccess(yield* askAndReply("session_clear_x", ASK_RULESET, "always"))).toBe(true)
      expect(Exit.isSuccess(yield* askAndReply("session_clear_y", ASK_RULESET, "always"))).toBe(true)

      yield* permission.clearGrants({ sessionID: "session_clear_x" })

      // x 的批条没了 ⇒ 重新进队列。
      const fiberX = yield* askSubject("session_clear_x", ASK_RULESET).pipe(Effect.forkScoped)
      const pendingX = yield* awaitPending()
      expect(pendingX.map((item) => item.sessionID)).toContain(SessionID.make("session_clear_x"))
      yield* permission.reply({ requestID: pendingX[0]!.id, reply: "reject" })
      yield* Fiber.await(fiberX)

      // y 的批条仍在 ⇒ 直接放行、不进队列。
      yield* askSubject("session_clear_y", ASK_RULESET)
      expect(yield* permission.list()).toHaveLength(0)

      // 全清 ⇒ y 也要重新问。
      yield* permission.clearGrants()
      const fiberY = yield* askSubject("session_clear_y", ASK_RULESET).pipe(Effect.forkScoped)
      const pendingY = yield* awaitPending()
      expect(pendingY.map((item) => item.sessionID)).toContain(SessionID.make("session_clear_y"))
      yield* permission.reply({ requestID: pendingY[0]!.id, reply: "reject" })
      yield* Fiber.await(fiberY)
    }),
  { git: true },
)

test("SUBJECT 字面量与生产 canonical 编码一致(独立锚点核对,不反向导出期望值)", async () => {
  const { canonicalToolIdentity } = await import("@opencode-ai/schema/tool-identity")
  expect(canonicalToolIdentity({ source: "mcp", origin: "policy", name: "paid_action" })).toBe(SUBJECT)
})
