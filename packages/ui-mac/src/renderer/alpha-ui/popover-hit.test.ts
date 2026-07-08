// REQ-061 — 弹层 click-outside 竞态:红绿对照(验收④)。
// 场景:点击处理器同步重渲染把被点按钮 detach → 事件到达 document 时 target 已脱离文档树。
// 旧判定(e.target.closest)对 detached 节点返回 null → 误判外部点击(红);
// 新判定(composedPath 快照)仍含弹层节点 → 正确识别内部点击(绿)。
// DOM-free:用结构性假对象模拟两种语义(closest 由调用方模拟 detach 后的返回值)。

import { describe, expect, test } from "bun:test"
import { pathHitsPopover, POP_CLASSES } from "./popover-hit"

/** 假节点:classList.contains 语义与真 DOM 一致。 */
const node = (...classes: string[]) => ({ classList: { contains: (c: string) => classes.includes(c) } })

describe("pathHitsPopover — REQ-061 composedPath 判定", () => {
  test("detach 场景红绿对照:closest 失败(红)/ composedPath 通过(绿)", () => {
    // 被点按钮(step1 预设行)—— 点击后被同步重渲染 detach
    const detachedButton = {
      ...node("a-pop-item"),
      // 旧判定语义:detached 节点已脱离文档树,closest 找不到任何祖先 → null
      closest: (_sel: string) => null,
    }
    const popRoot = node("a-pop", "a-pop-fixed")
    // composedPath 在 dispatch 时快照:即使按钮随后 detach,路径里仍有弹层根节点
    const snapshotPath = [detachedButton, popRoot, node(), {} /* document */, {} /* window */]

    expect(detachedButton.closest(".a-pop-wrap, .a-pop")).toBeNull() // 红:旧判定误判「外部」
    expect(pathHitsPopover(snapshotPath)).toBe(true) // 绿:新判定识别「内部」→ 不关层
  })

  test("真正的外部点击(路径无弹层节点)仍判外部 → 关层(验收③回归)", () => {
    const outside = [node("a-comp-input"), node("a-comp"), node(), {}]
    expect(pathHitsPopover(outside)).toBe(false)
  })

  test("chip 按钮路径(.a-pop-wrap)判内部 —— 开关切换不被 doc listener 抢关", () => {
    expect(pathHitsPopover([node("a-chip"), node("a-pop-wrap"), {}])).toBe(true)
  })

  test("window/document 等无 classList 节点安全跳过;空路径判外部", () => {
    expect(pathHitsPopover([{}, null, undefined, { classList: {} }])).toBe(false)
    expect(pathHitsPopover([])).toBe(false)
  })

  test("POP_CLASSES 覆盖两种弹层根形态(a-pop / a-pop-wrap)", () => {
    expect([...POP_CLASSES]).toEqual(["a-pop", "a-pop-wrap"])
  })
})
