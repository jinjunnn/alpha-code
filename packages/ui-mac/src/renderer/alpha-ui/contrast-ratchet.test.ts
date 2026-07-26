// C21 AC4 —— 对比度回归闸门。#478/PR#518 已把 --a-text-tertiary 与焦点指示器改到 AA 之上;
// 缺的一直是「改回去会红」的机制。算法搬自当时的一次性取证脚本
// docs/design/2026-07-22-c21-a11y-baseline/ac4-contrast-check.mjs(WCAG 2.x 相对亮度),
// 但值一律从 tokens.css 现读 —— 副本会随源漂移,漂移的闸门等于没有闸门。
// 形制镜像 reduced-motion-ratchet.test.ts:先用 fixture 证明判据本身会红,再扫真源。
import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const tokensPath = join(import.meta.dir, "tokens.css")

// tokens.css 的三个主题块。缺任何一个都要红:OS-fallback 块漏改过一次,
// 结果是「跟随系统深色」的用户拿着不达标的值(基线 §3.D 的显式告警)。
const THEME_BLOCKS = {
  light: ":root",
  dark: ':root[data-color-scheme="dark"]',
  "os-dark": ':root:not([data-color-scheme="light"]):not([data-color-scheme="dark"])',
} as const

// 相邻背景 = 三层容器面(画布/凹陷/悬停填充)与两层浮起面。文本落在其中任一之上都必须过 AA。
const BACKGROUNDS = ["--a-bg-canvas", "--a-bg-subtle", "--a-bg-muted", "--a-surface", "--a-surface-raised"] as const

const TEXT_MIN = 4.5 // WCAG 1.4.3 正文
const NON_TEXT_MIN = 3 // WCAG 1.4.11 焦点指示器等非文本

function channel(value: number) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string) {
  const raw = hex.replace("#", "")
  const full = raw.length === 3
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw
  const [r, g, b] = [0, 2, 4].map((offset) => channel(parseInt(full.slice(offset, offset + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export function contrastRatio(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/** 取出 selector 恰好匹配的规则块并合并声明(同名选择器出现多次时后者覆盖前者)。 */
function declarations(source: string, selector: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const merged = new Map<string, string>()
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.replace(/\s+/g, " ").trim() !== selector) continue
    for (const declaration of match[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      merged.set(declaration[1]!, declaration[2]!.trim())
    }
  }
  return merged
}

/** 主题块 = 浅色底盘 + 该块的覆盖(深色块只写差异),与浏览器的层叠一致。 */
function theme(source: string, selector: string) {
  const values = declarations(source, THEME_BLOCKS.light)
  if (selector !== THEME_BLOCKS.light) declarations(source, selector).forEach((value, name) => values.set(name, value))
  return values
}

/** 焦点指示器的颜色不硬编码:从 --a-ring-focus 现读它引用的 token,再解析成实色。 */
function focusIndicatorColor(values: Map<string, string>) {
  const ring = values.get("--a-ring-focus") ?? ""
  const reference = ring.match(/var\((--[a-z0-9-]+)\)/i)?.[1]
  return reference ? values.get(reference) : undefined
}

function offenders(source: string, label: string) {
  const found: string[] = []
  for (const [name, selector] of Object.entries(THEME_BLOCKS)) {
    const values = theme(source, selector)
    const tertiary = values.get("--a-text-tertiary")
    const ring = focusIndicatorColor(values)
    if (!tertiary) found.push(`${label} ${name}: --a-text-tertiary 未在本主题块定义`)
    // 实色才可判:回到 rgba() 半透明圈(基线 §3.D 候选①之前的形态)在此直接判红。
    if (!ring || !/^#[0-9a-f]{3,8}$/i.test(ring)) {
      found.push(`${label} ${name}: 焦点指示器未解析为实色(${ring ?? "缺 --a-ring-focus"})`)
    }
    for (const background of BACKGROUNDS) {
      const bg = values.get(background)
      if (!bg) {
        found.push(`${label} ${name}: ${background} 未定义`)
        continue
      }
      if (tertiary && contrastRatio(tertiary, bg) < TEXT_MIN) {
        found.push(`${label} ${name}: --a-text-tertiary on ${background} = ${contrastRatio(tertiary, bg).toFixed(2)}`)
      }
      if (ring && /^#[0-9a-f]{3,8}$/i.test(ring) && contrastRatio(ring, bg) < NON_TEXT_MIN) {
        found.push(`${label} ${name}: focus ring on ${background} = ${contrastRatio(ring, bg).toFixed(2)}`)
      }
    }
  }
  return found
}

describe("alpha-ui contrast ratchet", () => {
  test("ratio math reproduces the AC4 evidence numbers", () => {
    // 基线 §3.D 记录的失败值与 #478 落地后的值,两端各钉一个。
    expect(contrastRatio("#7c7d85", "#eceef1")).toBeCloseTo(3.52, 2)
    expect(contrastRatio("#6a6b73", "#eceef1")).toBeCloseTo(4.56, 2)
    expect(contrastRatio("#86878f", "#17181b")).toBeCloseTo(4.97, 2)
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5)
  })

  test("the judgement itself goes red on a regressed token set", () => {
    const regressed = `
      :root {
        --a-bg-canvas: #ffffff;
        --a-bg-subtle: #f6f7f9;
        --a-bg-muted: #eceef1;
        --a-surface: #ffffff;
        --a-surface-raised: #ffffff;
        --a-accent-ring: rgba(79, 70, 229, 0.45);
        --a-text-tertiary: #7c7d85;
        --a-ring-focus: 0 0 0 3px var(--a-accent-ring);
      }
    `
    // 三个主题块都从这份底盘继承,所以每个背景各红一次 —— 半透明焦点圈同样三块全红。
    const themes = Object.keys(THEME_BLOCKS).length
    const found = offenders(regressed, "fixture.css")
    expect(found.filter((entry) => entry.includes("--a-text-tertiary on"))).toHaveLength(BACKGROUNDS.length * themes)
    expect(found.filter((entry) => entry.includes("焦点指示器未解析为实色"))).toHaveLength(themes)
  })

  test("a theme block that silently drops the token is caught, not skipped", () => {
    const partial = `
      :root { --a-bg-canvas: #ffffff; --a-text-tertiary: #6a6b73; --a-accent: #4f46e5;
              --a-ring-focus: 0 0 0 1.5px var(--a-accent); }
    `
    expect(offenders(partial, "fixture.css").filter((entry) => entry.includes("--a-bg-subtle 未定义"))).toHaveLength(3)
  })

  test("tokens.css clears AA on every adjacent background in all three theme blocks", async () => {
    expect(offenders(await Bun.file(tokensPath).text(), "tokens.css")).toEqual([])
  })
})
