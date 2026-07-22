import { describe, expect, test } from "bun:test"
import { relative } from "node:path"

const alphaUi = import.meta.dir
const bareDuration = /\b(?:\d*\.)?\d+m?s\b/
type MotionProperty = "animation" | "transition"

function motionProperties(body: string) {
  return new Set(
    [...body.matchAll(/(?:^|;)\s*(animation|transition)(?:-duration)?\s*:\s*([^;]+)/gm)]
      .filter((match) => bareDuration.test(match[2]))
      .map((match) => match[1] as MotionProperty),
  )
}

function reducedProperties(body: string) {
  return new Set(
    [...body.matchAll(/(?:^|;)\s*(animation|transition)(?:-duration)?\s*:\s*(?:none|0m?s)\b/gm)]
      .map((match) => match[1] as MotionProperty),
  )
}

function rules(source: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "")
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
    body: match[2],
  }))
}

function reducedMotionBlocks(source: string) {
  const blocks: string[] = []
  const marker = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g
  for (const match of source.matchAll(marker)) {
    const start = match.index + match[0].length
    let depth = 1
    let end = start
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1
      if (source[end] === "}") depth -= 1
      end += 1
    }
    blocks.push(source.slice(start, end - 1))
  }
  return blocks
}

function uncoveredMotionSelectors(source: string, path: string) {
  const covered = new Map<MotionProperty, Set<string>>([
    ["animation", new Set()],
    ["transition", new Set()],
  ])
  reducedMotionBlocks(source)
    .flatMap(rules)
    .forEach((rule) =>
      reducedProperties(rule.body).forEach((property) =>
        rule.selectors.forEach((selector) => covered.get(property)!.add(selector)),
      ),
    )

  return rules(source).flatMap((rule) => {
    const properties = motionProperties(rule.body)
    if (properties.size === 0) return []
    // The button spinner communicates an in-flight operation and is the repository's explicit
    // essential-motion exception; every decorative motion selector must have an override.
    if (rule.selectors.length === 1 && rule.selectors[0] === ".a-btn[data-loading]::after") return []
    if ([...properties].every((property) => rule.selectors.every((selector) => covered.get(property)!.has(selector)))) return []
    return [`${path}: ${rule.selectors.join(", ")}`]
  })
}

describe("alpha-ui reduced-motion ratchet", () => {
  test("longhand durations require a same-property reduced-motion override", () => {
    const source = `
      .longhand-animation { animation-duration: 120ms; }
      .longhand-transition { transition-duration: 120ms; }
      .cross-property { animation: pulse 120ms; }
      .covered { transition: opacity 120ms; }
      @media (prefers-reduced-motion: reduce) {
        .cross-property { transition: none; }
        .covered { transition-duration: 0ms; }
      }
    `

    expect(uncoveredMotionSelectors(source, "fixture.css")).toEqual([
      "fixture.css: .longhand-animation",
      "fixture.css: .longhand-transition",
      "fixture.css: .cross-property",
    ])
  })

  test("bare animation and transition durations have a reduced-motion override", async () => {
    const paths = await Array.fromAsync(new Bun.Glob("**/*.css").scan({ cwd: alphaUi, absolute: true }))
    const offenders = (
      await Promise.all(
        paths.sort().map(async (path) => uncoveredMotionSelectors(await Bun.file(path).text(), relative(alphaUi, path))),
      )
    ).flat()

    expect(offenders).toEqual([])
  })
})
