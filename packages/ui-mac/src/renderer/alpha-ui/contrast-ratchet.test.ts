// C21 AC4 —— 对比度回归闸门。#478/PR#518 已把 --a-text-tertiary 与焦点指示器改到 AA 之上;
// 缺的一直是「改回去会红」的机制。算法搬自当时的一次性取证脚本
// docs/design/2026-07-22-c21-a11y-baseline/ac4-contrast-check.mjs(WCAG 2.x 相对亮度),
// 但值一律从 tokens.css 现读 —— 副本会随源漂移,漂移的闸门等于没有闸门。
// 形制镜像 reduced-motion-ratchet.test.ts:先用 fixture 证明判据本身会红,再扫真源。
//
// fail-closed 的含义在这里是字面的:凡是「算不出确定比值」的输入(半透明 rgba()、
// oklch()、currentColor、带 alpha 的 4/8 位 hex、token 缺失),一律判红。上一版把它们
// 喂给 parseInt 得到 NaN,而 `NaN < 4.5` 为 false —— 号称 fail-closed,实测 fail-open。
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

// 相邻背景 = 四层容器面(画布/凹陷/悬停填充/按下与轨道)与两层浮起面。文本落在其中任一之上
// 都必须过 AA。--a-bg-inset 不是理论项:alpha-composer.css 的发送按钮就是
// `background: var(--a-bg-inset); color: var(--a-text-tertiary)`。
const BACKGROUNDS = [
  "--a-bg-canvas",
  "--a-bg-subtle",
  "--a-bg-muted",
  "--a-bg-inset",
  "--a-surface",
  "--a-surface-raised",
] as const

/**
 * `#1375`:落在**半透明 tint** 上的文字。
 *
 * 上面那张表只判实色背景,而产品里有一整类提示条是「半透明色块 + 同色系文字」——
 * tint 自己不是实色,浏览器把它合成到它所在的那层底上之后才有确定比值,所以这里要
 * 先合成、再算。不合成就一条都判不了(本文件的 fail-closed 规则会把 rgba() 直接判红),
 * 于是这一类此前**结构性地不在任何闸门的射程内**。
 *
 * 今天只有一行:输入框提示槽那三条红提示(`.a-comp-model-alert`,`alpha-composer.css`)。
 * 全仓红字/底色配对的普查是另一件事(`#1375` out of scope 明写)。
 */
const TINTED_TEXT = [
  {
    fg: "--a-error-on-subtle",
    tint: "--a-error-subtle",
    base: "--a-surface",
    where: "输入框提示槽三条红提示(.a-comp-model-alert)",
  },
] as const

const TEXT_MIN = 4.5 // WCAG 1.4.3 正文
const NON_TEXT_MIN = 3 // WCAG 1.4.11 焦点指示器等非文本

/** 唯一可判的形态:不透明 #rgb / #rrggbb。4/8 位带 alpha 的 hex 也算不出确定比值。 */
const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function channel(value: number) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 不可判的输入返回 undefined —— 绝不返回 NaN,NaN 会在后续比较里静悄悄变成「通过」。 */
export function luminance(hex: string) {
  if (!OPAQUE_HEX.test(hex)) return undefined
  const raw = hex.slice(1)
  const full = raw.length === 3
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw
  const [r, g, b] = [0, 2, 4].map((offset) => channel(parseInt(full.slice(offset, offset + 2), 16)))
  const value = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return Number.isFinite(value) ? value : undefined
}

/** 半透明色的唯一可判形态:`rgb()` / `rgba()` 的逗号十进制写法。 */
const RGBA = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i

/**
 * `#1375`:把半透明色合成到不透明底上,得到浏览器真正画出来的那个实色。
 *
 * 与 `luminance` 同一条纪律 —— 不可判的输入返回 `undefined`,绝不返回一个看起来像颜色
 * 的东西:合成不出来就该判红,而不是拿个近似值去比。
 */
export function flatten(tint: string, base: string) {
  const parts = RGBA.exec(tint.trim())
  if (!parts || !OPAQUE_HEX.test(base)) return undefined
  const alpha = parts[4] === undefined ? 1 : Number(parts[4])
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined
  const raw = base.slice(1)
  const full = raw.length === 3
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw
  const under = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16))
  const channels: number[] = []
  for (const index of [0, 1, 2]) {
    const over = Number(parts[index + 1])
    if (!Number.isFinite(over) || over > 255) return undefined
    channels.push(Math.round(alpha * over + (1 - alpha) * under[index]!))
  }
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

export function contrastRatio(a: string, b: string) {
  const [first, second] = [luminance(a), luminance(b)]
  if (first === undefined || second === undefined) return undefined
  const [high, low] = [first, second].sort((x, y) => y - x)
  const ratio = (high! + 0.05) / (low! + 0.05)
  return Number.isFinite(ratio) ? ratio : undefined
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

export function offenders(source: string, label: string) {
  const found: string[] = []
  for (const [name, selector] of Object.entries(THEME_BLOCKS)) {
    const values = theme(source, selector)
    const where = `${label} ${name}`
    /** 解析阶段就把不可判的值记成违规,后续比较只跑在确定值上。 */
    const solid = (token: string, raw: string | undefined) => {
      if (raw === undefined) {
        found.push(`${where}: ${token} 未在本主题块定义`)
        return undefined
      }
      if (luminance(raw) === undefined) {
        found.push(`${where}: ${token} 不是可判的不透明色(${raw})`)
        return undefined
      }
      return raw
    }
    const measure = (fg: string | undefined, fgLabel: string, bg: string, bgLabel: string, min: number) => {
      if (fg === undefined) return
      const ratio = contrastRatio(fg, bg)
      if (ratio === undefined) {
        found.push(`${where}: ${fgLabel} on ${bgLabel} 比值不可判`)
        return
      }
      if (ratio < min) found.push(`${where}: ${fgLabel} on ${bgLabel} = ${ratio.toFixed(2)}`)
    }

    const tertiary = solid("--a-text-tertiary", values.get("--a-text-tertiary"))
    const ring = solid("焦点指示器", focusIndicatorColor(values))
    for (const background of BACKGROUNDS) {
      const bg = solid(background, values.get(background))
      if (bg === undefined) continue
      measure(tertiary, "--a-text-tertiary", bg, background, TEXT_MIN)
      measure(ring, "focus ring", bg, background, NON_TEXT_MIN)
    }

    // `#1375`:半透明 tint 上的文字 —— 先合成到它所在的那层底上,再判。
    for (const pair of TINTED_TEXT) {
      const fg = solid(pair.fg, values.get(pair.fg))
      const base = solid(pair.base, values.get(pair.base))
      const rawTint = values.get(pair.tint)
      if (rawTint === undefined) {
        found.push(`${where}: ${pair.tint} 未在本主题块定义(${pair.where})`)
        continue
      }
      const composited = base === undefined ? undefined : flatten(rawTint, base)
      if (composited === undefined) {
        // base 自己不可判时 solid() 已经记过一条;这里只补「tint 合成不出来」那一格。
        if (base !== undefined) found.push(`${where}: ${pair.tint} 合成不出实色(${rawTint} on ${pair.base})`)
        continue
      }
      measure(fg, pair.fg, composited, `${pair.tint} 合成在 ${pair.base} 上(= ${composited},${pair.where})`, TEXT_MIN)
    }
  }
  return found
}

const themes = Object.keys(THEME_BLOCKS).length

describe("alpha-ui contrast ratchet", () => {
  test("ratio math reproduces the AC4 evidence numbers", () => {
    // 基线 §3.D 记录的失败值、#478 落地后的值、以及本票把 --a-bg-inset 纳入后的新最差对。
    expect(contrastRatio("#7c7d85", "#eceef1")).toBeCloseTo(3.52, 2)
    expect(contrastRatio("#6a6b73", "#eceef1")).toBeCloseTo(4.56, 2)
    expect(contrastRatio("#6a6b73", "#e3e6ea")).toBeCloseTo(4.23, 2) // 纳入 inset 前的漏判值
    expect(contrastRatio("#64656d", "#e3e6ea")).toBeCloseTo(4.63, 2) // 现值,浅色最差对
    expect(contrastRatio("#86878f", "#1e2024")).toBeCloseTo(4.56, 2) // 深色最差对
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5)
  })

  test("#1375 合成算法复算出已批稿里的独立实测值", () => {
    // 锚点**不取自 tokens.css** —— 那是被测对象本身,拿它当期望值就是自指等价链。
    // 这七个数字是 docs/design/2026-09-19-req160-send-blocked-notice/design.md §5 里
    // 另一轮、另一套工具量出来并已随 owner 批准冻结的值(琥珀提示条那一格)。
    // 合成器若算错,这七条会一起塌,而不是悄悄给出一个近似值。
    const warnLight = flatten("rgba(217, 119, 6, 0.12)", "#ffffff")
    const warnDark = flatten("rgba(251, 191, 36, 0.14)", "#121316")
    expect(warnLight).toBe("#faefe1") // 稿里逐字写着「浅色主题下提示条底色实算为 rgb(250,239,225)」
    expect(contrastRatio("#18181b", warnLight!)).toBeCloseTo(15.61, 2) // --a-text
    expect(contrastRatio("#52525b", warnLight!)).toBeCloseTo(6.81, 2) // --a-text-secondary
    expect(contrastRatio("#d97706", warnLight!)).toBeCloseTo(2.81, 2) // --a-warning(稿里据此否掉了图标)
    expect(contrastRatio("#fafafa", warnDark!)).toBeCloseTo(13.42, 2)
    expect(contrastRatio("#a1a1aa", warnDark!)).toBeCloseTo(5.46, 2)
    expect(contrastRatio("#fbbf24", warnDark!)).toBeCloseTo(8.39, 2)
    // 同一份稿子记的缺陷值:三条红提示的 4.01:1(--a-error 落在 --a-error-subtle 上)。
    expect(contrastRatio("#dc2626", flatten("rgba(220, 38, 38, 0.12)", "#ffffff")!)).toBeCloseTo(4.01, 2)
  })

  test("#1375 改前的色值会让判据变红并点名它", () => {
    // 这就是 `#1375` 之前树上的样子:提示槽的文字色 = --a-error。判据必须点名那一对与那个数。
    const beforeFix = `
      :root {
        --a-bg-canvas: #ffffff; --a-bg-subtle: #f6f7f9; --a-bg-muted: #eceef1;
        --a-bg-inset: #e3e6ea; --a-surface: #ffffff; --a-surface-raised: #ffffff;
        --a-accent: #4f46e5; --a-text-tertiary: #64656d;
        --a-ring-focus: 0 0 0 1.5px var(--a-accent);
        --a-error-subtle: rgba(220, 38, 38, 0.12);
        --a-error-on-subtle: #dc2626;
      }
    `
    const found = offenders(beforeFix, "fixture.css").filter((entry) => entry.includes("--a-error-on-subtle on"))
    expect(found).toHaveLength(themes) // 三个主题块都从这份底盘继承 ⇒ 各红一次
    expect(found[0]).toContain("--a-error-subtle 合成在 --a-surface 上(= #fbe5e5")
    expect(found[0]).toContain("= 4.01")
    // 控制组:换成落地值即全绿 —— 否则这条断言可能只是「这个夹具怎么写都红」。
    expect(
      offenders(beforeFix.replace("#dc2626;", "#b91c1c;"), "fixture.css").filter((entry) =>
        entry.includes("--a-error-on-subtle on"),
      ),
    ).toEqual([])
  })

  test("#1375 tint 算不出实色或整块缺失时判红,不是静默跳过", () => {
    const base = `--a-bg-canvas: #ffffff; --a-bg-subtle: #f6f7f9; --a-bg-muted: #eceef1;
        --a-bg-inset: #e3e6ea; --a-surface: #ffffff; --a-surface-raised: #ffffff;
        --a-accent: #4f46e5; --a-text-tertiary: #64656d; --a-ring-focus: 0 0 0 1.5px var(--a-accent);`
    // ① tint 是 oklch():合成不出确定实色 ⇒ 记一条,不许当成「这一对没问题」。
    const unmeasurable = `:root { ${base} --a-error-subtle: oklch(0.7 0.19 25 / 12%); --a-error-on-subtle: #b91c1c; }`
    expect(offenders(unmeasurable, "fixture.css").filter((e) => e.includes("合成不出实色"))).toHaveLength(themes)
    // ② tint 一个主题块都没定义 ⇒ 记一条(而不是因为 `undefined` 就跳过这一对)。
    const missing = `:root { ${base} --a-error-on-subtle: #b91c1c; }`
    expect(
      offenders(missing, "fixture.css").filter((e) => e.includes("--a-error-subtle 未在本主题块定义")),
    ).toHaveLength(themes)
    // ③ 文字色缺失同样要红 —— 这条走的是既有的 solid(),但少了它整对就无声消失。
    const noText = `:root { ${base} --a-error-subtle: rgba(220, 38, 38, 0.12); }`
    expect(
      offenders(noText, "fixture.css").filter((e) => e.includes("--a-error-on-subtle 未在本主题块定义")),
    ).toHaveLength(themes)
  })

  test("anything that cannot be measured is undefined, never NaN", () => {
    // 这一条钉的就是上一版的失效路径:parseInt 吃到非 hex 得 NaN,`NaN < 4.5` 为 false,
    // 于是「透明前景」一路绿到底。现在它们没有比值,调用方拿到 undefined 必须显式判红。
    for (const value of ["rgba(0,0,0,0)", "oklch(0.6 0.02 260)", "currentColor", "#0000", "#12345678", "", "#12"]) {
      expect(luminance(value)).toBeUndefined()
      expect(contrastRatio(value, "#ffffff")).toBeUndefined()
      expect(contrastRatio("#ffffff", value)).toBeUndefined()
    }
  })

  test("the judgement itself goes red on a regressed token set", () => {
    const regressed = `
      :root {
        --a-bg-canvas: #ffffff;
        --a-bg-subtle: #f6f7f9;
        --a-bg-muted: #eceef1;
        --a-bg-inset: #e3e6ea;
        --a-surface: #ffffff;
        --a-surface-raised: #ffffff;
        --a-accent-ring: rgba(79, 70, 229, 0.45);
        --a-text-tertiary: #7c7d85;
        --a-ring-focus: 0 0 0 3px var(--a-accent-ring);
      }
    `
    // 三个主题块都从这份底盘继承,所以每个背景各红一次 —— 半透明焦点圈同样三块全红。
    const found = offenders(regressed, "fixture.css")
    expect(found.filter((entry) => entry.includes("--a-text-tertiary on"))).toHaveLength(BACKGROUNDS.length * themes)
    expect(found.filter((entry) => entry.includes("焦点指示器 不是可判的不透明色"))).toHaveLength(themes)
  })

  test("a non-hex foreground or background is red, not silently skipped", () => {
    // 变异形态:把 tertiary 换成 oklch()、把一个背景换成透明。上一版这两处都会算出 NaN 并全绿。
    const unmeasurable = `
      :root {
        --a-bg-canvas: #ffffff;
        --a-bg-subtle: #f6f7f9;
        --a-bg-muted: #eceef1;
        --a-bg-inset: rgba(0, 0, 0, 0);
        --a-surface: #ffffff;
        --a-surface-raised: #ffffff;
        --a-accent: #4f46e5;
        --a-text-tertiary: oklch(0.6 0.02 260);
        --a-ring-focus: 0 0 0 1.5px var(--a-accent);
      }
    `
    const found = offenders(unmeasurable, "fixture.css")
    expect(found.filter((entry) => entry.includes("--a-text-tertiary 不是可判的不透明色"))).toHaveLength(themes)
    expect(found.filter((entry) => entry.includes("--a-bg-inset 不是可判的不透明色"))).toHaveLength(themes)
    // 焦点圈是实色,它对其余五个背景仍要判,并且判得出。
    expect(found.filter((entry) => entry.includes("比值不可判"))).toHaveLength(0)
  })

  test("a theme block that silently drops the token is caught, not skipped", () => {
    const partial = `
      :root { --a-bg-canvas: #ffffff; --a-text-tertiary: #64656d; --a-accent: #4f46e5;
              --a-ring-focus: 0 0 0 1.5px var(--a-accent); }
    `
    expect(offenders(partial, "fixture.css").filter((entry) => entry.includes("--a-bg-subtle 未在本主题块定义"))).toHaveLength(3)
    expect(offenders(partial, "fixture.css").filter((entry) => entry.includes("--a-bg-inset 未在本主题块定义"))).toHaveLength(3)
  })

  test("tokens.css clears AA on every adjacent background in all three theme blocks", async () => {
    expect(offenders(await Bun.file(tokensPath).text(), "tokens.css")).toEqual([])
  })
})
