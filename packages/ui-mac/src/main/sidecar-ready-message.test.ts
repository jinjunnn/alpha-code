// #613(R1 Blocker 2)最后一英里的**运行时**反向闸门。R1 实证:把 sidecar.ts 的转发表达式
// 变异为 `injectionFailure: injection.error && undefined` 后,四条源码文本锚仍全绿,但实际
// IPC 丢失失败字段 —— 文本锚证明「字样在源码里」,证明不了「值真的上车」。
// 现在 ready 消息构造住在 bun 可真执行的 buildReadyMessage(sidecar.ts 唯一的 ready 通路,
// 接线锚见 alpha-config-injection.test.ts),这里对生产函数的输出做**整体深比较 + 属性存在性**
// 双断言:任何让 injectionFailure 变成 undefined / 缺失 / 改名 / 内容截断的等义改写都当场转红。
import { describe, expect, test } from "bun:test"
import { buildReadyMessage } from "./sidecar-ready-message"

describe("buildReadyMessage —— ready IPC 的注入失败字段(#613 运行时闸门)", () => {
  test("失败结果必须整体上车:message/stack 原样挂在 injectionFailure 上", () => {
    const error = {
      message: "ENOSPC: no space left on device, write",
      stack: "Error: ENOSPC\n    at materializeV2EngineConfig",
    }
    // 深比较锁整条消息。R1 变异 `injection.error && undefined` 在此转红:
    // toEqual 期望的是 error 对象本体,undefined 顶不上。
    expect(buildReadyMessage({ ok: false, error })).toEqual({ type: "ready", injectionFailure: error })
  })

  test("失败结果无 stack 时 message 仍原样上车(stack 可选,不得因缺席改形)", () => {
    const error = { message: "EEXIST: file already exists, mkdir" }
    expect(buildReadyMessage({ ok: false, error })).toEqual({ type: "ready", injectionFailure: error })
  })

  test("成功结果不得携带 injectionFailure —— 连值为 undefined 的键也不行", () => {
    const msg = buildReadyMessage({ ok: true })
    expect(msg).toEqual({ type: "ready" })
    // toEqual 把「键缺失」与「键=undefined」视为相等,单靠它挡不住
    // `injectionFailure: injection.ok ? undefined : injection.error` 这类改形 —— 补属性级断言。
    expect("injectionFailure" in msg).toBe(false)
  })
})
