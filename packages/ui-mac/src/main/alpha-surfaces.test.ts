// REQ-084:surface 解析/落盘单测。契约:env > pin > 发布默认;凡会产出 alpha 的态(alpha 与
// auto-fallback,不论哪层命中)只对「本 app 版本」的崩溃记录降 legacy(旧版本记录陈旧忽略;
// #334:硬 alpha 不豁免,否则 fatal 后无 legacy 兜底 → crash-loop);文件损坏按空处理;失败记录
// 截 500 字符且剥离绝对路径样式片段;未知 surface id 直接拒绝。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// registerSurfaceIpc 需要 electron / logging —— 纯函数测试下打桩(getLogger 未 init 时本就为 undefined)。
mock.module("electron", () => ({ app: { getVersion: () => "9.9.9" }, ipcMain: { handle: () => {} } }))
mock.module("./logging", () => ({ getLogger: () => undefined }))

const { readSurfaceFile, recordSurfaceFailure, resolveSurfaces } = await import("./alpha-surfaces")

const FILE = "alpha-surfaces.json"
let tmp = ""
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-surfaces-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("resolveSurfaces — 发布默认", () => {
  test("home/newSession → alpha,session → legacy(全部 release-default)", () => {
    const r = resolveSurfaces({ env: {}, file: {}, appVersion: "1.0.0" })
    expect(r.home).toEqual({ mode: "alpha", reason: "release-default" })
    expect(r.newSession).toEqual({ mode: "alpha", reason: "release-default" })
    expect(r.session).toEqual({ mode: "legacy", reason: "release-default" })
  })
})

describe("resolveSurfaces — 层级:env > pin > 默认", () => {
  test("pin 覆盖发布默认", () => {
    const r = resolveSurfaces({ env: {}, file: { pins: { session: "alpha" } }, appVersion: "1.0.0" })
    expect(r.session).toEqual({ mode: "alpha", reason: "pin" })
  })

  test("env 覆盖 pin", () => {
    const r = resolveSurfaces({
      env: { ALPHA_SURFACE_HOME: "legacy" },
      file: { pins: { home: "alpha" } },
      appVersion: "1.0.0",
    })
    expect(r.home).toEqual({ mode: "legacy", reason: "env-override" })
  })

  test("非法 env 值忽略 → 落到 pin", () => {
    const r = resolveSurfaces({
      env: { ALPHA_SURFACE_SESSION: "banana" },
      file: { pins: { session: "alpha" } },
      appVersion: "1.0.0",
    })
    expect(r.session).toEqual({ mode: "alpha", reason: "pin" })
  })
})

describe("resolveSurfaces — 崩溃记录 × 一切产出 alpha 的态(#334 fail-safe)", () => {
  const failure = (appVersion: string, id: "home" | "session" = "home") => ({
    failures: { [id]: { at: "2026-07-12T00:00:00.000Z", appVersion, error: "boom" } },
  })

  test("auto-fallback(发布默认)+ 本版本记录过失败 → legacy(crash-fallback)", () => {
    const r = resolveSurfaces({ env: {}, file: failure("1.0.0"), appVersion: "1.0.0" })
    expect(r.home).toEqual({ mode: "legacy", reason: "crash-fallback" })
  })

  test("旧版本的失败记录陈旧忽略 → alpha", () => {
    const r = resolveSurfaces({ env: {}, file: failure("0.9.0"), appVersion: "1.0.0" })
    expect(r.home).toEqual({ mode: "alpha", reason: "release-default" })
  })

  test("#334 回归:显式 pin=alpha 不再豁免崩溃记录 → legacy(crash-fallback)", () => {
    const r = resolveSurfaces({ env: {}, file: { ...failure("1.0.0"), pins: { home: "alpha" } }, appVersion: "1.0.0" })
    expect(r.home).toEqual({ mode: "legacy", reason: "crash-fallback" })
  })

  test("env=auto-fallback + 本版本失败记录 → legacy(crash-fallback)", () => {
    const r = resolveSurfaces({ env: { ALPHA_SURFACE_HOME: "auto-fallback" }, file: failure("1.0.0"), appVersion: "1.0.0" })
    expect(r.home).toEqual({ mode: "legacy", reason: "crash-fallback" })
  })

  test("#334 回归:env 强推 session=alpha + 本版本失败记录 → legacy(crash-fallback)", () => {
    const r = resolveSurfaces({
      env: { ALPHA_SURFACE_SESSION: "alpha" },
      file: failure("1.0.0", "session"),
      appVersion: "1.0.0",
    })
    expect(r.session).toEqual({ mode: "legacy", reason: "crash-fallback" })
  })

  test("#334:硬 alpha 态下旧版本记录仍陈旧忽略 → alpha(env-override)——版本升级即自然恢复", () => {
    const r = resolveSurfaces({
      env: { ALPHA_SURFACE_SESSION: "alpha" },
      file: failure("0.9.0", "session"),
      appVersion: "1.0.0",
    })
    expect(r.session).toEqual({ mode: "alpha", reason: "env-override" })
  })

  test("#334 复现全路径:强推 session=alpha → reportFailure 落盘 → re-resolve 必得 legacy", () => {
    const env = { ALPHA_SURFACE_SESSION: "alpha" }
    const before = resolveSurfaces({ env, file: readSurfaceFile(tmp), appVersion: "1.0.0" })
    expect(before.session).toEqual({ mode: "alpha", reason: "env-override" })
    recordSurfaceFailure(tmp, "1.0.0", { surface: "session", error: "fatal render" })
    const after = resolveSurfaces({ env, file: readSurfaceFile(tmp), appVersion: "1.0.0" })
    expect(after.session).toEqual({ mode: "legacy", reason: "crash-fallback" })
  })
})

describe("readSurfaceFile — 容错读侧", () => {
  test("文件缺失 → 空", () => {
    expect(readSurfaceFile(tmp)).toEqual({})
  })

  test("损坏 JSON → 空(默认解析不受影响)", () => {
    fs.writeFileSync(path.join(tmp, FILE), "{not json!!!")
    expect(readSurfaceFile(tmp)).toEqual({})
    const r = resolveSurfaces({ env: {}, file: readSurfaceFile(tmp), appVersion: "1.0.0" })
    expect(r.home.mode).toBe("alpha")
  })

  test("非法 pin 值 / 残缺 failure 条目逐项丢弃", () => {
    fs.writeFileSync(
      path.join(tmp, FILE),
      JSON.stringify({ pins: { home: "banana", session: "alpha" }, failures: { home: { at: "x" } } }),
    )
    expect(readSurfaceFile(tmp)).toEqual({ pins: { session: "alpha" } })
  })
})

describe("recordSurfaceFailure — 落盘卫生", () => {
  test("截断 500 字符 + 剥离路径样式片段", () => {
    const noisy =
      "Error at /Users/someone/project/src/App.tsx and /home/someone/x.ts and C:\\Users\\someone " +
      "x".repeat(600)
    recordSurfaceFailure(tmp, "1.0.0", { surface: "home", error: noisy })
    const saved = readSurfaceFile(tmp).failures?.home
    expect(saved).toBeDefined()
    expect(saved!.appVersion).toBe("1.0.0")
    expect(saved!.error.length).toBeLessThanOrEqual(500)
    expect(saved!.error).not.toContain("/Users/")
    expect(saved!.error).not.toContain("/home/")
    expect(saved!.error).not.toContain(":\\")
  })

  test("合并写入:保留既有 pins 与其他 surface 的记录", () => {
    fs.writeFileSync(
      path.join(tmp, FILE),
      JSON.stringify({
        pins: { session: "alpha" },
        failures: { newSession: { at: "2026-07-01T00:00:00.000Z", appVersion: "0.9.0", error: "old" } },
      }),
    )
    recordSurfaceFailure(tmp, "1.0.0", { surface: "home", error: "boom" })
    const saved = readSurfaceFile(tmp)
    expect(saved.pins).toEqual({ session: "alpha" })
    expect(saved.failures?.newSession?.error).toBe("old")
    expect(saved.failures?.home?.appVersion).toBe("1.0.0")
  })

  test("未知 surface id 拒绝(不落盘)", () => {
    expect(() => recordSurfaceFailure(tmp, "1.0.0", { surface: "sidebar" as never, error: "x" })).toThrow(
      "unknown surface id",
    )
    expect(fs.existsSync(path.join(tmp, FILE))).toBe(false)
  })
})
