import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const tsx = readFileSync(join(import.meta.dir, "surface-boundary.tsx"), "utf8")
const rendererRoot = join(import.meta.dir, "..")
const rendererSources = [...new Bun.Glob("**/*.{ts,tsx,js,jsx}").scanSync(rendererRoot)]
  .filter((file) => !/\.(test|spec)\.[jt]sx?$/.test(file))
  .map((file) => ({ file, source: readFileSync(join(rendererRoot, file), "utf8") }))

describe("SurfaceBoundary — Alpha-only Recovery ratchet", () => {
  test("one fallback creates one stable crashID and asks main for a safe incident", () => {
    expect(tsx.match(/globalThis\.crypto\.randomUUID\(\)/g)).toHaveLength(1)
    expect(tsx).toContain(".reportFailure({ crashID: globalThis.crypto.randomUUID(), surface: props.surface })")
    expect(tsx).toContain("admitSurfaceRecovery")
  })

  test("legacy reload and fallback release state are absent from the entire renderer", () => {
    const forbidden = [
      {
        name: "location.reload",
        pattern: /\b(?:globalThis\.\s*|window\.\s*)?location\s*(?:\.\s*reload\b|\[\s*["']reload["']\s*\])/,
      },
      { name: "legacy fallback release state", pattern: /auto-fallback|crash-fallback|回退旧版/ },
    ]
    const offenders = rendererSources.flatMap((entry) =>
      forbidden
        .filter((rule) => rule.pattern.test(entry.source))
        .map((rule) => ({ file: entry.file, rule: rule.name })),
    )
    expect(offenders).toEqual([])
  })

  test("raw error presentation is deleted from the isolated surface fallback", () => {
    expect(tsx).not.toContain("error.message")
    expect(tsx).not.toContain("error: failure")
    expect(tsx).not.toContain("{props.surface}")
  })

  test("the failed region remains isolated while the sole Recovery host owns interaction", () => {
    // #475 externalised the fallback copy to i18n; the prompt now lives in the dictionary and the
    // surface wires it via t("alpha.error.recoveryPrompt"). Assert the token is present (the copy
    // itself is verified in the i18n dictionaries) rather than a raw locale-specific literal.
    expect(tsx).toContain('t("alpha.error.recoveryPrompt")')
    expect(tsx).toContain('data-alpha-surface-error="isolated"')
  })
})
