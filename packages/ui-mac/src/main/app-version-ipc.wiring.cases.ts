// ac#1187 —— app-version IPC 的取值来源闸门(不是「返回了个像版本号的字符串」)。
//
// 判据钉在唯一真源上:handler 的返回必须是 app.getVersion() 的**实时值** ——
// 在两次 invoke 之间换掉 getVersion 的返回值,IPC 返回必须跟着变。任何把版本写成
// 字面量的实现(不管抄的是当时的真版本还是别的)在其中至少一格上当场红。
//
// 子进程运行(app-version-ipc.wiring.test.ts spawn):mock.module("electron") 在同进程会
// 泄漏进 `bun test src` 里其它文件 —— 同仓 models-catalog-v2.wiring.* 同因同法。

import { expect, mock, test } from "bun:test"

/** 生产代码注册到 ipcMain 上的 handler —— 测试只能经这里拿到它。 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
let version = "9.9.9-first"

mock.module("electron", () => ({
  app: { getVersion: () => version },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}))

const { registerAppVersionIpcHandler } = await import("./app-version-ipc")

test("app-version IPC 返回 app.getVersion() 的实时值(换掉真源 ⇒ 返回跟着变)", async () => {
  registerAppVersionIpcHandler()
  const handler = handlers.get("app-version")
  expect(handler, "生产 register 没往 app-version 频道挂 handler").toBeDefined()
  expect(await handler!()).toBe("9.9.9-first")
  version = "8.8.8-mutated"
  expect(await handler!()).toBe("8.8.8-mutated")
})
