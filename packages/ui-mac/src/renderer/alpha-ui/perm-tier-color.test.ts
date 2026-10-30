// #1550 AC1 —— 三档运行权限在输入框入口、权限菜单、菜单选中态用同一种颜色。
//
// 改前的树:入口 `allow` = --a-warning(黄)、`ask` 落在 .a-chip 的中性色、`readonly` = --a-accent;
// 菜单选中态一律 `.a-pop-item.is-on { color: var(--a-accent) }`(home.css)—— 于是「全部批准」
// 入口黄、菜单里蓝。这里逐档逐位置读真 CSS,断言每一处都引用同一个 `--a-perm-<档>`。
import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const dir = import.meta.dir
const MODES = ["allow", "ask", "readonly"] as const
const THEME_BLOCKS = [
  ":root",
  ':root[data-color-scheme="dark"]',
  ':root:not([data-color-scheme="light"]):not([data-color-scheme="dark"])',
] as const

type Rule = { selectors: string[]; body: string }

function rules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "")
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
    body: match[2]!,
  }))
}

function colorOf(body: string) {
  return body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/)?.[1]?.trim()
}

/** 每档必须被着色的位置:入口文字、入口图标、菜单行图标、选中行文字、选中行图标。 */
function slots(mode: string) {
  return [
    `.a-chip-perm[data-mode="${mode}"]`,
    `.a-chip-perm[data-mode="${mode}"] .a-ic`,
    `.a-pop-item[data-perm="${mode}"] .a-ic`,
    `.a-pop-item.is-on[data-perm="${mode}"]`,
    `.a-pop-item.is-on[data-perm="${mode}"] .a-ic`,
  ]
}

async function styleRules() {
  const files = ["alpha-composer.css", "home.css"]
  return (await Promise.all(files.map((file) => Bun.file(join(dir, file)).text()))).flatMap(rules)
}

describe("#1550 AC1 permission tier colors", () => {
  test("every position of a tier references that tier's one token", async () => {
    const all = await styleRules()
    for (const mode of MODES) {
      for (const slot of slots(mode)) {
        const colors = all.filter((rule) => rule.selectors.includes(slot)).map((rule) => colorOf(rule.body))
        expect({ slot, colors }).toEqual({ slot, colors: [`var(--a-perm-${mode})`] })
      }
      // 任何一条按档位选中的规则都不许带第二种颜色(防止旁路再写一条 data-mode 覆盖)。
      const stray = all
        .filter((rule) => rule.selectors.some((s) => s.includes(`data-mode="${mode}"`) || s.includes(`data-perm="${mode}"`)))
        .map((rule) => colorOf(rule.body))
        .filter((color) => color !== undefined && color !== `var(--a-perm-${mode})`)
      expect({ mode, stray }).toEqual({ mode, stray: [] })
    }
  })

  test("the chip and menu rows carry the attributes those selectors key on", async () => {
    const source = await Bun.file(join(dir, "alpha-composer.tsx")).text()
    expect(source).toContain('class="a-chip a-chip-perm"')
    expect(source).toContain("data-mode={composerPerm()}")
    expect(source).toContain("data-perm={mode}")
  })

  test("each tier token is a measurable color in every theme block, distinct per tier, never the warning amber", async () => {
    const tokens = rules(await Bun.file(join(dir, "tokens.css")).text())
    const block = (selector: string) => {
      const values = new Map<string, string>()
      for (const rule of tokens.filter((r) => r.selectors.length === 1 && r.selectors[0] === selector))
        for (const m of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) values.set(m[1]!, m[2]!.trim())
      return values
    }
    const light = block(":root")
    for (const selector of THEME_BLOCKS) {
      const values = new Map([...light, ...block(selector)])
      const tiers = MODES.map((mode) => values.get(`--a-perm-${mode}`))
      for (const value of tiers) expect(value).toMatch(/^#[0-9a-f]{6}$/i)
      expect(new Set(tiers).size).toBe(MODES.length)
      expect(tiers).not.toContain(values.get("--a-warning"))
    }
  })
})
