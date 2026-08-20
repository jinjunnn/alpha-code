import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function matchingClose(source: string, openBraceIndex: number): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  let templateExpr = 0
  for (let i = openBraceIndex; i < source.length; i++) {
    const c = source[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (c === "\\") {
        escaped = true
        continue
      }
      if (quote === "`" && c === "$" && source[i + 1] === "{") {
        templateExpr++
        i++
        continue
      }
      if (templateExpr > 0) {
        if (c === "{") templateExpr++
        else if (c === "}") templateExpr--
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function bracedIfBodies(source: string, header: string): Array<{ body: string; close: number }> {
  const bodies: Array<{ body: string; close: number }> = []
  let from = 0
  while (true) {
    const at = source.indexOf(header, from)
    if (at < 0) return bodies
    let j = at + header.length
    while (j < source.length && /\s/.test(source[j]!)) j++
    if (source[j] === "{") {
      const close = matchingClose(source, j)
      if (close > j) bodies.push({ body: source.slice(j + 1, close), close })
    }
    from = at + header.length
  }
}

test("index.ts calls runBootDanglingSweep outside every TEST_ONBOARDING skip", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  const skipBodies = bracedIfBodies(source, "if (!TEST_ONBOARDING)")
  expect(skipBodies.length).toBeGreaterThan(0)

  const mustStaySkipped = [
    "reconcileFactorySkills",
    "reconcileEngineConfigTruth",
    "reconcileDesiredStateAtBoot",
    "runGlobalEcosystemGate",
  ]
  for (const symbol of mustStaySkipped) {
    expect(
      skipBodies.some((block) => block.body.includes(symbol)),
      `${symbol} must remain inside if (!TEST_ONBOARDING)`,
    ).toBe(true)
  }

  for (const block of skipBodies) {
    expect(block.body.includes("runBootDanglingSweep")).toBe(false)
    expect(block.body.includes('phase: "boot"')).toBe(false)
  }

  const calls = source.match(/runBootDanglingSweep\s*\(/g) ?? []
  expect(calls).toHaveLength(1)
  const bootCall = source.indexOf("runBootDanglingSweep(")
  const firstFork = source.indexOf("spawnLocalServer(")
  expect(bootCall).toBeGreaterThan(-1)
  expect(firstFork).toBeGreaterThan(bootCall)

  const factorySkip = skipBodies.find((block) => block.body.includes("reconcileFactorySkills"))
  expect(factorySkip).toBeDefined()
  expect(bootCall).toBeGreaterThan(factorySkip!.close)
})
