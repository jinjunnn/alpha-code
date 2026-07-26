import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RECOVERY_CODES } from "../shared/recovery"

mock.module("electron", () => ({
  app: { getVersion: () => "9.9.9" },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {} },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))
mock.module("./logging", () => ({ write: () => {}, getLogger: () => undefined, rotateServerLogs: () => {} }))

const { readSurfaceFile, recordSurfaceFailure } = await import("./alpha-surfaces")
const FILE = "alpha-surfaces.json"
let tmp = ""

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-surfaces-"))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("surface failure diagnostics", () => {
  test("writes only a stable code and never persists renderer error, path, or secret", () => {
    recordSurfaceFailure(tmp, "1.0.0", { surface: "home" })
    const saved = readSurfaceFile(tmp).failures?.home
    expect(saved).toMatchObject({ appVersion: "1.0.0", error: RECOVERY_CODES.surfaceCrashed })
    expect(JSON.stringify(saved)).not.toContain("/Users/")
    expect(JSON.stringify(saved)).not.toContain("secret")
  })

  test("merges other failure records and drops any leftover release pin", () => {
    writeFileSync(
      join(tmp, FILE),
      JSON.stringify({
        pins: { session: "legacy" },
        failures: {
          newSession: { at: "2026-07-01T00:00:00.000Z", appVersion: "0.9.0", error: RECOVERY_CODES.surfaceCrashed },
        },
      }),
    )
    recordSurfaceFailure(tmp, "1.0.0", { surface: "home" })
    const saved = readSurfaceFile(tmp)
    // 发布态硬切之后 pin 不再有语义:读掉、不回写,一台装过旧版的机器也不会被它改变 composition。
    expect(saved).not.toHaveProperty("pins")
    expect(JSON.stringify(saved)).not.toContain("legacy")
    expect(saved.failures?.newSession?.error).toBe(RECOVERY_CODES.surfaceCrashed)
    expect(saved.failures?.home?.appVersion).toBe("1.0.0")
  })

  test("unknown surface and failed atomic write fail closed without exposing a path", () => {
    expect(() => recordSurfaceFailure(tmp, "1.0.0", { surface: "sidebar" as never })).toThrow("unknown surface id")
    mkdirSync(join(tmp, FILE))
    let thrown: Error | undefined
    try {
      recordSurfaceFailure(tmp, "1.0.0", { surface: "home" })
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown?.message).toContain("failed to persist surface failure record")
    expect(thrown?.message).not.toContain(tmp)
  })

  test("successful write is atomic, 0600, and corrupt input reads as empty", () => {
    recordSurfaceFailure(tmp, "1.0.0", { surface: "home" })
    expect(readdirSync(tmp).filter((name) => name.includes(".tmp-"))).toEqual([])
    if (process.platform !== "win32") expect(statSync(join(tmp, FILE)).mode & 0o777).toBe(0o600)
    writeFileSync(join(tmp, FILE), "{not json")
    expect(readSurfaceFile(tmp)).toEqual({})
  })
})
