// REQ-021 A1 验收⑥ —— 调度纯逻辑单测:cron 解析/下次触发/interval 锚定/错过判定/人话描述。
// 时区注意:nextFire 用系统本地时区;测试全部用本地时间构造 Date,不依赖具体 tz。

import { describe, expect, test } from "bun:test"
import { describeSchedule, isValidCron, nextFire, parseCron, rescheduleAfterGap } from "./automation-schedule"

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0)

describe("parseCron", () => {
  test("5 字段基本形 + 星号 + 列表 + 区间 + 步进", () => {
    const spec = parseCron("0 9 * * 1-5")
    expect([...spec.minute]).toEqual([0])
    expect([...spec.hour]).toEqual([9])
    expect(spec.dom).toBeNull()
    expect([...spec.dow!].sort()).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron("0 8,20 * * *").hour]).toEqual([8, 20])
  })
  test("周 7 归一为 0(周日)", () => {
    expect([...parseCron("0 9 * * 7").dow!]).toEqual([0])
  })
  test("非法:字段数/越界/垃圾", () => {
    expect(isValidCron("0 9 * *")).toBe(false)
    expect(isValidCron("61 9 * * *")).toBe(false)
    expect(isValidCron("a b c d e")).toBe(false)
    expect(isValidCron("0 9 * * 1-5")).toBe(true)
  })
})

describe("nextFire — cron", () => {
  test("每天 09:00:今天没过取今天,过了取明天", () => {
    const sched = { kind: "cron", expr: "0 9 * * *" } as const
    expect(nextFire(sched, local(2026, 7, 4, 8, 0))!.getTime()).toBe(local(2026, 7, 4, 9, 0).getTime())
    expect(nextFire(sched, local(2026, 7, 4, 9, 0))!.getTime()).toBe(local(2026, 7, 5, 9, 0).getTime())
  })
  test("工作日 09:00:周五之后跳到周一(2026-07-04 是周六)", () => {
    const sched = { kind: "cron", expr: "0 9 * * 1-5" } as const
    const next = nextFire(sched, local(2026, 7, 4, 10, 0))!
    expect(next.getDay()).toBe(1)
    expect(next.getTime()).toBe(local(2026, 7, 6, 9, 0).getTime())
  })
  test("每月 31 日:跳过短月", () => {
    const sched = { kind: "cron", expr: "0 9 31 * *" } as const
    const next = nextFire(sched, local(2026, 9, 1, 0, 0))! // 9 月无 31 → 10/31
    expect(next.getMonth() + 1).toBe(10)
    expect(next.getDate()).toBe(31)
  })
  test("dom+dow 同时受限 = OR(vixie 语义)", () => {
    // 每月 1 日 或 每周一,09:00。2026-07-04(周六)之后最近的是 07-06(周一),早于 08-01。
    const sched = { kind: "cron", expr: "0 9 1 * 1" } as const
    expect(nextFire(sched, local(2026, 7, 4, 0, 0))!.getTime()).toBe(local(2026, 7, 6, 9, 0).getTime())
  })
  test("永不匹配(2/30)→ null", () => {
    expect(nextFire({ kind: "cron", expr: "0 9 30 2 *" }, local(2026, 7, 4))).toBeNull()
  })
})

describe("nextFire — interval 锚定", () => {
  const anchor = local(2026, 7, 4, 10, 0)
  const sched = { kind: "interval", everyMinutes: 30 } as const
  test("从锚点整周期对齐,非漂移", () => {
    expect(nextFire(sched, local(2026, 7, 4, 10, 10), anchor)!.getTime()).toBe(local(2026, 7, 4, 10, 30).getTime())
    // 正好落在周期点上 → 严格大于 after,取下一格
    expect(nextFire(sched, local(2026, 7, 4, 10, 30), anchor)!.getTime()).toBe(local(2026, 7, 4, 11, 0).getTime())
  })
  test("锚点在未来(刚创建)→ 首次即锚点", () => {
    expect(nextFire(sched, local(2026, 7, 4, 9, 0), anchor)!.getTime()).toBe(anchor.getTime())
  })
})

describe("nextFire — once", () => {
  test("未来触发一次;过期 null;垃圾 null", () => {
    const at = local(2026, 7, 5, 9, 0)
    expect(nextFire({ kind: "once", at: at.toISOString() }, local(2026, 7, 4))!.getTime()).toBe(at.getTime())
    expect(nextFire({ kind: "once", at: at.toISOString() }, local(2026, 7, 6))).toBeNull()
    expect(nextFire({ kind: "once", at: "garbage" }, local(2026, 7, 4))).toBeNull()
  })
})

describe("rescheduleAfterGap — 错过判定(catchUpPolicy:skip)", () => {
  const sched = { kind: "cron", expr: "0 9 * * *" } as const
  test("planned 未到期 → 原样保留", () => {
    const planned = local(2026, 7, 5, 9, 0)
    const r = rescheduleAfterGap(sched, planned, local(2026, 7, 4, 12, 0))
    expect(r.missed).toBe(false)
    expect(r.next!.getTime()).toBe(planned.getTime())
  })
  test("睡眠错过(planned 已过)→ 跳过不补,按 now 重算", () => {
    const r = rescheduleAfterGap(sched, local(2026, 7, 4, 9, 0), local(2026, 7, 4, 14, 0))
    expect(r.missed).toBe(true)
    expect(r.next!.getTime()).toBe(local(2026, 7, 5, 9, 0).getTime())
  })
  test("planned 为空(首次装载)→ 直接算下一次,不算错过", () => {
    const r = rescheduleAfterGap(sched, null, local(2026, 7, 4, 8, 0))
    expect(r.missed).toBe(false)
    expect(r.next!.getTime()).toBe(local(2026, 7, 4, 9, 0).getTime())
  })
})

describe("describeSchedule — 人话周期", () => {
  test("常见形状", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *" })).toBe("每天 09:00")
    expect(describeSchedule({ kind: "cron", expr: "30 18 * * 1-5" })).toBe("工作日 18:30")
    expect(describeSchedule({ kind: "cron", expr: "0 10 * * 0,6" })).toBe("周末 10:00")
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1" })).toBe("每周一 09:00")
    expect(describeSchedule({ kind: "cron", expr: "0 9 15 * *" })).toBe("每月 15 日 09:00")
    expect(describeSchedule({ kind: "interval", everyMinutes: 30 })).toBe("每 30 分钟")
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("每 2 小时")
  })
  test("识别不了的形状如实回落 cron 原文", () => {
    expect(describeSchedule({ kind: "cron", expr: "*/5 * * * *" })).toBe("cron */5 * * * *")
  })
})
