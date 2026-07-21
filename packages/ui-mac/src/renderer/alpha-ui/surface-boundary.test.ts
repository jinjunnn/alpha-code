import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const tsx = readFileSync(join(import.meta.dir, "surface-boundary.tsx"), "utf8")

describe("SurfaceBoundary — Alpha-only Recovery ratchet", () => {
  test("one fallback creates one stable crashID and asks main for a safe incident", () => {
    expect(tsx.match(/globalThis\.crypto\.randomUUID\(\)/g)).toHaveLength(1)
    expect(tsx).toContain(".reportFailure({ crashID: globalThis.crypto.randomUUID(), surface: props.surface })")
    expect(tsx).toContain("admitSurfaceRecovery")
  })

  test("legacy reload and raw error presentation are deleted", () => {
    expect(tsx).not.toContain("location.reload")
    expect(tsx).not.toContain("重新加载")
    expect(tsx).not.toContain("回退旧版")
    expect(tsx).not.toContain("error.message")
    expect(tsx).not.toContain("error: failure")
    expect(tsx).not.toContain("{props.surface}")
  })

  test("the failed region remains isolated while the sole Recovery host owns interaction", () => {
    expect(tsx).toContain("请在 Recovery 面板中选择安全操作。")
    expect(tsx).toContain('data-alpha-surface-error="isolated"')
  })
})
