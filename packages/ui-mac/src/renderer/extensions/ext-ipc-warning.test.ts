// `#765`:warning 呈现咽喉本身的单测。
//
// 这里判的是**机制**,不是某六个调用点:咽喉之所以能替代「逐调用点写一行」,靠的是它对
// **从没见过的方法名**默认生效。所以下面的用例故意用一个仓库里不存在的 IPC 名字 ——
// 名单式实现(`new Set(["installCatalog", ...])`)会当场变红,而看返回值的实现照过。
//
// 生产接线(真 ExtensionHub + 真 ToastViewport + 真 `.a-toast` DOM)由
// test-component/ext-package-detail-wiring.cases.ts 判;本文件不碰 solid,也不 mock.module。
import { describe, expect, test } from "bun:test"
import { actionWarningOf, presentActionWarning, warningPresentingExt } from "./ext-ipc-warning"

describe("actionWarningOf:什么算一条要呈现的具名 warning", () => {
  test("成功响应上的非空 warning 字符串", () => {
    expect(actionWarningOf({ ok: true, warning: "残留没删掉" })).toBe("残留没删掉")
  })

  test("失败响应上的 warning 同样算(后端哪天挂上去,不必再改这一层)", () => {
    expect(actionWarningOf({ ok: false, reason: "boom", warning: "顺带说一句" })).toBe("顺带说一句")
  })

  test.each([
    // 违规项(该被呈现的那个)故意不放第一位:退化夹具会让「恒 undefined」的实现也全绿。
    ["复数 warnings 是成批诊断清单,有自己的呈现位置", { warnings: ["a", "b"] }],
    ["空字符串不是信号", { ok: true, warning: "" }],
    ["纯空白不是信号", { ok: true, warning: "   \n\t " }],
    ["非字符串不猜意思", { ok: true, warning: { text: "nope" } }],
    ["数字不猜意思", { ok: true, warning: 42 }],
    ["没有 warning 字段", { ok: true, reason: "reload-pending" }],
    ["null", null],
    ["undefined", undefined],
    ["字符串本身", "warning"],
    ["函数(订阅通道的退订函数走这条)", () => {}],
  ])("不算:%s", (_label, value) => {
    expect(actionWarningOf(value)).toBeUndefined()
  })
})

describe("presentActionWarning:呈现之后原样交回", () => {
  test("有 warning:呈现一次,返回值是**同一个**对象引用(不复制、不改写)", () => {
    const seen: string[] = []
    const result = { ok: true, warning: "x" }
    expect(presentActionWarning(result, (w) => seen.push(w))).toBe(result)
    expect(seen).toEqual(["x"])
  })

  test("没有 warning:零呈现", () => {
    const seen: string[] = []
    presentActionWarning({ ok: true }, (w) => seen.push(w))
    expect(seen).toEqual([])
  })
})

/** 每个用例自带一副底座:一个可替换的 ext 替身 + 收到的呈现记录。 */
function harness(ext: Record<string, unknown>) {
  const presented: string[] = []
  let current = ext
  const facade = warningPresentingExt<Record<string, unknown>>(
    () => current,
    (warning) => presented.push(warning),
  )
  return { facade, presented, swap: (next: Record<string, unknown>) => (current = next) }
}

describe("warningPresentingExt:咽喉对新成员默认覆盖", () => {
  test("从没见过的方法名照样呈现 —— 名单式实现在这条上必红", async () => {
    const h = harness({
      // 仓库里不存在这个 IPC。名单实现拿不到它,看返回值的实现拿得到。
      aBrandNewIpcNobodyHasWrittenYet: async () => ({ ok: true, warning: "新通道的具名 warning" }),
    })
    const call = h.facade.aBrandNewIpcNobodyHasWrittenYet as () => Promise<unknown>
    await call()
    expect(h.presented).toEqual(["新通道的具名 warning"])
  })

  test("返回值原样交回调用方(呈现是旁路,不改数据)", async () => {
    const answer = { ok: true, warning: "w", installed: ["a"] }
    const h = harness({ installCatalog: async () => answer })
    const call = h.facade.installCatalog as () => Promise<unknown>
    expect(await call()).toBe(answer)
  })

  test("同步返回的订阅通道:退订函数原样透出,零呈现", () => {
    let disposed = 0
    const h = harness({ onSessionGrantsEnded: () => () => disposed++ })
    const call = h.facade.onSessionGrantsEnded as () => () => void
    const dispose = call()
    expect(typeof dispose).toBe("function")
    dispose()
    expect({ disposed, presented: h.presented }).toEqual({ disposed: 1, presented: [] })
  })

  test("实参与 this 都落到底层实现上", async () => {
    const ext: Record<string, unknown> = {
      marker: "the real ext object",
      uninstallV2(this: { marker?: string }, ...args: unknown[]) {
        return Promise.resolve({ ok: true, args, self: this.marker })
      },
    }
    const h = harness(ext)
    const call = h.facade.uninstallV2 as (...a: unknown[]) => Promise<unknown>
    expect(await call({ type: "skill" }, 7)).toEqual({
      ok: true,
      args: [{ type: "skill" }, 7],
      self: "the real ext object",
    })
  })

  test("底层对象每次调用重新读 —— 组件测试是先加载模块、后铺 window.api 的", async () => {
    const h = harness({ setInstallState: async () => ({ ok: true }) })
    h.swap({ setInstallState: async () => ({ ok: true, warning: "换了一副底座" }) })
    const call = h.facade.setInstallState as () => Promise<unknown>
    await call()
    expect(h.presented).toEqual(["换了一副底座"])
  })

  test("底层是 Proxy(contextBridge 替身 / IPC 桩)时也必须调对函数", async () => {
    // 回归锁:第一版用 `member.apply(ext, args)`,而读 `.apply` 会被 Proxy 的 get 陷阱接管,
    // 于是订阅方法返回的是另一个 IPC 节点(Promise)而不是退订函数,Solid 在 cleanup 阶段炸掉。
    // 这正是 overlay-close 的 IPC 桩的形状,所以这条用例复刻它。
    const trapped = new Proxy({} as Record<string, unknown>, {
      get: (_target, property) => {
        if (typeof property === "symbol" || property === "then") return undefined
        if (property === "onSessionGrantsEnded") return () => () => {}
        // 任何**别的**属性(含 `apply` / `call` / `bind`)都被解析成又一个 IPC 节点。
        return async () => ({ ok: true, warning: `resolved-as-ipc-node:${String(property)}` })
      },
    })
    const h = harness(trapped)
    const call = h.facade.onSessionGrantsEnded as () => unknown
    expect(typeof call()).toBe("function")
    expect(h.presented).toEqual([])
  })

  test("被拒的 promise 原样上抛,不吞、不呈现", async () => {
    const h = harness({
      installCatalog: async () => {
        throw new Error("bridge down")
      },
    })
    const call = h.facade.installCatalog as () => Promise<unknown>
    await expect(call()).rejects.toThrow("bridge down")
    expect(h.presented).toEqual([])
  })

  test("非函数成员原样透出(本层不决定它不能存在)", () => {
    const h = harness({ someConstant: 3 })
    expect(h.facade.someConstant).toBe(3)
  })
})
