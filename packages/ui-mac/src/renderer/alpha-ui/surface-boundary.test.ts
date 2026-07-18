// #334 r1 回归锚:SurfaceBoundary 的 reload 门控必须在 main 确认崩溃记录落盘成功之后。
// surface-boundary.tsx 无法在 bun test 直接 import(solid-js JSX 编译 + css 副作用),与
// surface-seam-contract / alpha-session-workspace 测试同款形态:源码锚点钉死契约结构。
// 锚点变更 = 门控契约变更,必须随实现同步评审,不得静默改。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const tsx = readFileSync(join(import.meta.dir, "surface-boundary.tsx"), "utf8")

describe("SurfaceBoundary — reload 门控在落盘确认之后(#334 r1)", () => {
  test("上报不再 fire-and-forget:三态信号驱动,IPC 兑现才置 ok、拒绝置 failed", () => {
    expect(tsx).not.toContain("void window.api.surfaces")
    expect(tsx).toContain('createSignal<"pending" | "ok" | "failed">("pending")')
    expect(tsx).toContain('inflight.then(() => setPersisted("ok")).catch(() => setPersisted("failed"))')
  })

  test("location.reload 唯一调用点被 ok 门控包裹;非 ok 点击只重试上报", () => {
    expect(tsx.match(/location\.reload\(\)/g)).toHaveLength(1)
    expect(tsx).toContain('onClick={() => (persisted() === "ok" ? location.reload() : report())}')
    expect(tsx).toContain('disabled={persisted() === "pending"}')
  })

  test("失败窗口如实呈现:上报通道缺失/写入失败 → failed,不得声称已落盘", () => {
    expect(tsx).toContain('setPersisted("failed")')
    expect(tsx).not.toContain("上报已落盘")
    expect(tsx).toContain("错误记录保存失败,点击重试")
  })
})
