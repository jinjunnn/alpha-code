import { describe, expect, test } from "bun:test"
import { lockedPickAction, nextEngineRetryDelay } from "./model-picker-logic"

describe("lockedPickAction (REQ-083)", () => {
  test("登出态永远引导登录(与引擎状态无关)", () => {
    expect(lockedPickAction("out", true, false)).toBe("login")
    expect(lockedPickAction("out", false, false)).toBe("login")
  })

  test("余额不足永远引导充值(与引擎状态无关)", () => {
    expect(lockedPickAction("empty", true, false)).toBe("recharge")
    expect(lockedPickAction("empty", false, true)).toBe("recharge")
  })

  test("会员/余额态 + 引擎在线 + 代理缺席 → activate(genuine 激活,respawn 是修复)", () => {
    expect(lockedPickAction("member", true, false)).toBe("activate")
    expect(lockedPickAction("balance", true, false)).toBe("activate")
    expect(lockedPickAction("error", true, false)).toBe("activate")
  })

  test("引擎不可达时一律 none —— 杜绝「点灰行 → respawn → 再点」自续循环(REQ-083 根因)", () => {
    expect(lockedPickAction("member", false, false)).toBe("none")
    expect(lockedPickAction("balance", false, false)).toBe("none")
    expect(lockedPickAction("error", false, false)).toBe("none")
  })

  test("代理已在线则无事可做(此时行本不该 locked)", () => {
    expect(lockedPickAction("member", true, true)).toBe("none")
    expect(lockedPickAction("balance", true, true)).toBe("none")
  })
})

describe("nextEngineRetryDelay", () => {
  test("退避节奏 1s/2s/4s/8s 封顶", () => {
    expect(nextEngineRetryDelay(0)).toBe(1000)
    expect(nextEngineRetryDelay(1)).toBe(2000)
    expect(nextEngineRetryDelay(2)).toBe(4000)
    expect(nextEngineRetryDelay(3)).toBe(8000)
    expect(nextEngineRetryDelay(10)).toBe(8000)
  })
})
