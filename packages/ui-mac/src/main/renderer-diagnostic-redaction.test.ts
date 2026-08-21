// #900:renderer 崩溃/故障诊断落盘不得携带用户工作区绝对路径或原始异常文本。
//
// 两层判据:
// ① 行为闸(下方 describe 块)——用真实的 `safeRouteLabel`/`safeErrorName`(零 Electron 依赖,
//    可直接单测)喂一个真实工作区绝对路径构造的崩溃场景,断言产出文本不含 `/Users/`、不含可
//    base64 解码回绝对路径的段、不含原始 `Error:` 文本。若脱敏出口本身被削弱(比如改回直接拼
//    URL/`.message`),这层立刻变红。
// ② 接线闸(文末 describe 块)——源码文本断言 windows.ts 的四条崩溃通道与 logging.ts 的
//    renderer console 采集确实调用了这层脱敏出口,而不是绕过它直接落 `win.webContents.getURL()`
//    / 原始 `details`/`error`/`preloadPath`。若有人把调用点改回直接落原始字段(脱敏出口还在但
//    没人用了),这层变红——两层合起来覆盖「脱敏出口被摘掉」的两种形态。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { safeErrorName, safeRouteLabel } from "./renderer-diagnostic-redaction"
import { encodeDirectory } from "../shared/route-manifest"

const WORKSPACE_DIR = "/Users/alice/projects/secret-app"
const SLUG = encodeDirectory(WORKSPACE_DIR)

/** Any base64url-alphabet segment ≥ 8 chars that decodes back to an absolute path. */
function containsDecodableAbsolutePathSegment(text: string): boolean {
  const candidates = text.match(/[A-Za-z0-9_-]{8,}/g) ?? []
  for (const candidate of candidates) {
    try {
      const padding = "=".repeat((4 - (candidate.length % 4)) % 4)
      const binary = atob(candidate.replace(/-/g, "+").replace(/_/g, "/") + padding)
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      )
      if (decoded.startsWith("/")) return true
    } catch {
      continue
    }
  }
  return false
}

function assertClean(payload: unknown) {
  const text = JSON.stringify(payload)
  expect(text).not.toContain("/Users/")
  expect(text.includes(SLUG)).toBe(false)
  expect(containsDecodableAbsolutePathSegment(text)).toBe(false)
  expect(text).not.toMatch(/Error:/)
}

describe("#900 renderer diagnostic redaction — behavior", () => {
  test("safeRouteLabel never leaks the encoded workspace directory for a real crash URL", () => {
    const crashUrl = `oc://renderer/server/${SLUG}/session/sess_7f3a9c`
    const label = safeRouteLabel(crashUrl)
    expect(label).toBe("session")
    assertClean({ routeId: label })
  })

  test("safeRouteLabel degrades to a closed 'recovery'/'unparseable' label instead of echoing an unmatched or malformed URL", () => {
    assertClean({ routeId: safeRouteLabel(`oc://renderer/server/${SLUG}/not-a-real-route`) })
    assertClean({ routeId: safeRouteLabel("not a url at all") })
    assertClean({ routeId: safeRouteLabel("") })
  })

  test("a full four-channel crash payload built the way windows.ts builds it never contains the workspace path, a decodable path segment, or raw Error: text", () => {
    const currentURL = `oc://renderer/server/${SLUG}/session/sess_7f3a9c`
    const validatedURL = `oc://renderer/server/${SLUG}/session/sess_7f3a9c`
    const preloadPath = `/Users/alice/Applications/alpha-code.app/Contents/Resources/app.asar/preload.js`
    const thrown = new Error(`ENOENT: no such file or directory, open '${WORKSPACE_DIR}/.opencode/plugin.js'`)

    // did-fail-load / did-fail-provisional-load
    assertClean({
      window: "main",
      event: "did-fail-load",
      errorCode: -6,
      routeId: safeRouteLabel(validatedURL),
      currentRouteId: safeRouteLabel(currentURL),
      isMainFrame: true,
    })

    // render-process-gone
    assertClean({
      window: "main",
      routeId: safeRouteLabel(currentURL),
      reason: "crashed",
      exitCode: 1,
    })

    // unresponsive / responsive
    assertClean({ window: "main", routeId: safeRouteLabel(currentURL) })

    // preload-error — the path is dropped entirely, only the error's constructor name survives
    assertClean({ window: "main", errorName: safeErrorName(thrown) })
    expect(safeErrorName(thrown)).toBe("Error")
    const errorNameText = JSON.stringify(safeErrorName(thrown))
    expect(errorNameText).not.toContain(preloadPath)
    expect(errorNameText).not.toContain(WORKSPACE_DIR)
  })

  test("safeErrorName exposes only the constructor name, never .message or .stack", () => {
    expect(safeErrorName(new TypeError("bad value at /Users/alice/secret"))).toBe("TypeError")
    expect(safeErrorName("plain string thrown")).toBe("string")
    expect(safeErrorName(null)).toBe("null")
    expect(safeErrorName(undefined)).toBe("undefined")
  })
})

describe("#900 renderer diagnostic redaction — wiring ratchet (source-shape)", () => {
  const windows = readFileSync(join(import.meta.dir, "windows.ts"), "utf8")
  const logging = readFileSync(join(import.meta.dir, "logging.ts"), "utf8")

  test("ANCHOR (not a gate): did-fail-load/did-fail-provisional-load route both URLs through safeRouteLabel, not raw getURL()/validatedURL", () => {
    expect(windows).toContain("routeId: safeRouteLabel(validatedURL)")
    expect(windows).toContain("currentRouteId: safeRouteLabel(win.webContents.getURL())")
    expect(windows).not.toMatch(/currentURL:\s*win\.webContents\.getURL\(\)/)
    expect(windows).not.toMatch(/\bvalidatedURL,\s*\n\s*(currentURL|isMainFrame)/)
  })

  test("ANCHOR (not a gate): render-process-gone logs the closed reason/exitCode pair through safeRouteLabel, not the raw details object or getURL()", () => {
    expect(windows).toContain("safeRouteLabel(win.webContents.getURL()), reason: details.reason, exitCode: details.exitCode")
    expect(windows).not.toMatch(/currentURL:\s*win\.webContents\.getURL\(\),\s*details\s*}/)
  })

  test("ANCHOR (not a gate): unresponsive/responsive log through safeRouteLabel", () => {
    const matches = windows.match(/routeId: safeRouteLabel\(win\.webContents\.getURL\(\)\)/g) ?? []
    // did-fail-load(×2 via the shared `failed` closure) + render-process-gone + unresponsive + responsive
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  test("ANCHOR (not a gate): preload-error drops the absolute preloadPath and raw error object, keeping only safeErrorName", () => {
    expect(windows).toContain("errorName: safeErrorName(error)")
    expect(windows).not.toMatch(/\{\s*window: name,\s*preloadPath,\s*error\s*\}/)
    // the raw preload path param is no longer read anywhere in the handler
    expect(windows).toContain('"preload-error", (_event, _preloadPath, error)')
  })

  test("ANCHOR (not a gate): the terminal console-message listener no longer forwards raw message content to pty.log", () => {
    expect(windows).toContain('writeLog("pty", "console", { window: name, level, line, sourceId })')
    expect(windows).not.toContain('writeLog("pty", "console", { window: name, level, message, line, sourceId })')
  })

  test("ANCHOR (not a gate): spyRendererConsole is off — no whole-console-stream capture to renderer.log", () => {
    expect(logging).toContain("spyRendererConsole: false")
    expect(logging).not.toContain("spyRendererConsole: true")
  })
})
