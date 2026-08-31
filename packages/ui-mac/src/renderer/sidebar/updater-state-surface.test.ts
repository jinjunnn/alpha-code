// [ac#1207] REQ-147 AC1 —— 映射对 `UpdaterState["status"]` 联合类型穷尽的运行时闸门。
//
// 编译期那半场由源文件的 `Record<UpdaterState["status"], …>` 标注承担(上游新增 status
// 而映射缺项 = tsgo 红)。但 ui-mac 的 tsconfig 排除 *.test.ts 且 bun 直接剥类型 ——
// 「从映射里删掉一个 status」在**测试运行**里必须也红,不能只指望有人跑 typecheck。
// 锚点是下面的独立字面量清单(ALL_STATUSES),不从被测映射或上游类型推导 —— 期望值与
// 被测对象同源 = 自指等价链,一起改错就一起自洽(《本机验证陷阱》)。

import { describe, expect, test } from "bun:test"
import { UPDATER_STATUS_SURFACE, updaterSurfaceFor, updaterSurfaceParams } from "./updater-state-surface"
import type { UpdaterState } from "@opencode-ai/app/updater"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"

/** 独立字面量:@opencode-ai/app/updater 的 UpdaterState.status 全体成员,手抄,不导入推导。 */
const ALL_STATUSES = [
  "disabled",
  "idle",
  "checking",
  "downloading",
  "ready",
  "up-to-date",
  "installing",
  "error",
] as const

/** 有可见呈现的六个 status(disabled/idle 是确定的「不画」)。 */
const VISIBLE_STATUSES = ["checking", "downloading", "ready", "up-to-date", "installing", "error"] as const

/** 每个 status 一个样本状态(带 version/message 载荷),供 params / 门控断言用。 */
const SAMPLE: Record<(typeof ALL_STATUSES)[number], UpdaterState> = {
  disabled: { status: "disabled" },
  idle: { status: "idle" },
  checking: { status: "checking" },
  downloading: { status: "downloading", version: "9.9.7" },
  ready: { status: "ready", version: "9.9.7" },
  "up-to-date": { status: "up-to-date" },
  installing: { status: "installing", version: "9.9.7" },
  error: { status: "error", message: "boom" },
}

describe("updater-state-surface(REQ-147 AC1)", () => {
  test("映射恰好覆盖 status 联合类型的全部成员 —— 少一个红,多一个也红", () => {
    expect(Object.keys(UPDATER_STATUS_SURFACE).sort()).toEqual([...ALL_STATUSES].sort())
  })

  test("六个可见 status 的文案在 en 与 zh 里都登记,且各自互不相同", () => {
    for (const locale of [en, zh] as const) {
      const copies = VISIBLE_STATUSES.map((status) => {
        const spec = UPDATER_STATUS_SURFACE[status]
        expect(spec, `status=${status} 应有可见呈现`).not.toBeNull()
        const copy = (locale as Record<string, string>)[spec!.textKey]
        expect(typeof copy, `key=${spec!.textKey} 应在词典里`).toBe("string")
        expect(copy!.length).toBeGreaterThan(0)
        return copy!
      })
      expect(new Set(copies).size, `文案必须互不相同:${copies.join(" | ")}`).toBe(VISIBLE_STATUSES.length)
    }
  })

  test("disabled / idle 是确定的「不画」,不是缺项", () => {
    expect(UPDATER_STATUS_SURFACE.disabled).toBeNull()
    expect(UPDATER_STATUS_SURFACE.idle).toBeNull()
  })

  test("ready 带 install 动作;其余可见 status 不带", () => {
    expect(UPDATER_STATUS_SURFACE.ready?.action).toBe("install")
    for (const status of VISIBLE_STATUSES) {
      if (status === "ready") continue
      expect(UPDATER_STATUS_SURFACE[status]?.action).toBeUndefined()
    }
  })

  test("插值参数:downloading/ready/installing 带版本号,error 带错误消息", () => {
    expect(updaterSurfaceParams(SAMPLE.downloading)).toEqual({ version: "9.9.7" })
    expect(updaterSurfaceParams(SAMPLE.ready)).toEqual({ version: "9.9.7" })
    expect(updaterSurfaceParams(SAMPLE.installing)).toEqual({ version: "9.9.7" })
    expect(updaterSurfaceParams(SAMPLE.error)).toEqual({ message: "boom" })
  })

  test("unsolicited 门控:downloading/ready/installing 不请自来也显示;checking/up-to-date/error 只在主动检查后显示", () => {
    for (const status of ["downloading", "ready", "installing"] as const) {
      expect(updaterSurfaceFor(SAMPLE[status], false), `${status} 应无条件可见`).not.toBeNull()
    }
    for (const status of ["checking", "up-to-date", "error"] as const) {
      expect(updaterSurfaceFor(SAMPLE[status], false), `${status} 未主动检查时应隐藏`).toBeNull()
      expect(updaterSurfaceFor(SAMPLE[status], true), `${status} 主动检查后应可见`).not.toBeNull()
    }
    expect(updaterSurfaceFor(SAMPLE.disabled, true)).toBeNull()
    expect(updaterSurfaceFor(SAMPLE.idle, true)).toBeNull()
  })
})
