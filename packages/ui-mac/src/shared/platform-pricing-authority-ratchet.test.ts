// Platform-pricing authority ratchet — a SOURCE-TEXT gate on the model catalog, and the boundary
// of what that can mean.
//
// THE PRIMARY JUDGEMENT IS NOT IN THIS FILE. Three executed tests decide behaviour:
//   * `renderer/alpha-ui/model-picker-core.test.ts` — the row projection and the two pricing
//     states, over real fixtures, in both locales;
//   * `renderer/alpha-ui/model-default-core.test.ts` — that default resolution cannot see price
//     or catalog order;
//   * `renderer/alpha-ui/alpha-composer-model.component.test.ts` — the production Solid picker,
//     asserting the numbers land in BOTH the visible DOM and the `aria-label`.
// Change what the app actually shows and those move, whatever the source text says.
//
// WHAT THIS FILE COVERS is the one thing an executed test cannot: that the deleted local price
// authority has not GROWN BACK somewhere the executed tests never look. REQ-127 #679 removed a
// hardcoded ladder in `main/alpha-models.json` — `tiers: {flag: "×8", pro: "×3", std: "×1"}` plus a
// `tier` on every model — which was wrong twice over:
//   ① for models it did list, the number had nothing to do with the real multiplier;
//   ② for models the platform had launched but the local snapshot had not caught up with, the
//      projection SYNTHESISED the cheapest rung. claude-fable-5 is 输入 71.4× / 输出 178.6× and it
//      read "标准 ×1".
// The real authority is the gateway's `GET /v1/models` (ADR-039): `PlatformModel.pricing` +
// `EffectiveCatalog.pricingBasisModelId`. Re-adding a local rung is a one-line change in a config
// file, it looks harmless in review, and no executed test in this repo would necessarily red —
// the picker would just start showing a number again. Hence a ratchet.
//
// WHAT THIS IS NOT. A barrier against someone trying to get past it. Everything here is a lexical
// read of a FIXED list of files. Known and deliberately open:
//   * a price ladder introduced under different spelling (`grade`, `band`, `rung`, `级别`);
//   * a ladder placed in a file outside the list below — another JSON, a new module, a remote
//     config, generated code;
//   * a multiplier written as text the patterns do not model (`8x`, `八倍`, `mult: 8` computed at
//     runtime from a table keyed by something else).
// Closing those means enumerating the ways a human can express "price", which is the same defect
// as enumerating gates by filename. Read a green here as "the deleted axis did not come back under
// its own name", never as "no local price claim can exist".
//
// THE `1x` PROBE, AND WHERE IT IS ACTUALLY CLOSED. R1 appended `1x` — a LATIN x, not `×` — to an
// unavailable platform row. Nothing here fires, and nothing here ever will: every rule below is an
// enumeration, and an enumeration lets new members through by default. Extending the regex would
// only move the boundary one member outward. The class is closed at the throat instead, in the
// behavioural delegates, by pinning the COMPLETE value rather than forbidding shapes: the row's
// status elements are an exact ordered list, the row's whole visible text is an exact string, and
// the `aria-label` is an exact string. A fabricated multiplier of any spelling changes all three.
//
// COMMENTS ARE STRIPPED before the code rules run (`.ts` / `.tsx` only). This gate judges code and
// data, not prose: a comment explaining WHY there is no local tier — this one included — must not
// be a red light. `alpha-models.json` has no comment syntax, so it is read whole, `_note` included,
// and that is deliberate: `_note` is the instruction a human follows when editing the catalog, and
// "retune tier/倍率" written there is exactly how the field grows back.
//
// THE SCANNER IS SELF-TESTED. A ratchet whose patterns are subtly wrong reports zero violations and
// looks like a pass — the worst failure mode a gate has. The bottom of this file feeds it known
// violations of every rule and asserts each is caught, plus real strings that must NOT trip it
// (`deepseek-v4-pro`, `provider`, `flagship`).

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dict as en } from "../renderer/i18n/en"
import { dict as zh } from "../renderer/i18n/zh"

const packageRoot = join(import.meta.dir, "../..")

/**
 * The model-catalog surface, fixed by hand. Narrow on purpose: `tier` is a perfectly ordinary word
 * elsewhere in this repo (extension curation shelves, `tabs-preclean` tier-1/tier-2, cloud
 * execution tiers), and a repo-wide scan would drown in those and get relaxed until it means
 * nothing. Everything the platform-pricing path touches is here; a new file on that path has to be
 * added here too, which is the maintenance cost this list is paying for its precision.
 */
const CATALOG_SURFACE = [
  "src/main/alpha-models.json",
  "src/main/alpha-models.ts",
  "src/main/alpha-live-allowlist.ts",
  "src/main/alpha-platform-models.ts",
  "src/shared/alpha-model-types.ts",
  "src/renderer/alpha-ui/model-picker-core.ts",
  "src/renderer/alpha-ui/model-default-core.ts",
  "src/renderer/alpha-ui/alpha-composer-model.tsx",
] as const

type Rule = { rule: string; pattern: RegExp }

const PRICE_AUTHORITY_RULES: readonly Rule[] = [
  {
    // The deleted axis, by its own name. `[Tt]iers?` covers `tier` / `tiers` / `Tier` / `Tiers`,
    // so the erased `export type Tier` and the erased `catalog.tiers[...]` lookup share one rule.
    // A real word boundary, not a literal `\b`: without it this fires inside `provider`.
    rule: "local pricing tier axis (deleted in #679)",
    pattern: /\b[Tt]iers?\b/,
  },
  {
    // `mult` was the display string on each rung (`"×8"`). It has no other meaning on this surface.
    rule: "local pricing multiplier field (deleted in #679)",
    pattern: /\bmults?\b/i,
  },
  {
    // The three rung ids, but only as a WHOLE quoted value. `\bpro\b` would fire on the real model
    // id `deepseek-v4-pro` (a hyphen is a word boundary) — a false red on production data in the
    // very file being scanned, which is how a gate gets deleted.
    rule: "pricing rung id as a literal value",
    pattern: /(["'`])\s*(?:std|pro|flag)\s*\1/,
  },
  {
    // The user-visible rung labels. These are what the picker actually printed.
    rule: "pricing rung label (标准/高级/旗舰)",
    pattern: /标准|高级|旗舰/,
  },
  {
    // A numeric multiplier claim written into source or config, in either order. `71.4×` is the
    // shape the new i18n template produces at RUNTIME from platform data, which is fine; a literal
    // one here means a hardcoded price. The templates themselves interpolate (`{{input}}×`) and so
    // carry no digit next to the sign.
    rule: "hardcoded numeric multiplier",
    pattern: /\d(?:\.\d+)?\s*×|×\s*\d/,
  },
]

/** Offset-free comment whiteout. The `[^:]` guard keeps `https://` from reading as a line comment. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (comment) => comment.replace(/[^\n]/g, " "))
}

/** Every rule the text trips, by name. Exported shape is the scanner the self-test exercises. */
export function priceClaimsIn(text: string, options: { stripComments: boolean }): string[] {
  const body = options.stripComments ? withoutComments(text) : text
  return PRICE_AUTHORITY_RULES.filter((entry) => entry.pattern.test(body)).map((entry) => entry.rule)
}

const scanFile = (relative: string) => {
  const absolute = join(packageRoot, relative)
  const source = readFileSync(absolute, "utf8")
  // JSON has no comment syntax; its prose (`_note`) is data a human edits by instruction.
  return priceClaimsIn(source, { stripComments: !relative.endsWith(".json") }).map((rule) => `${relative}: ${rule}`)
}

/** i18n entries whose KEY is on the model surface. `alpha.ext.cloudTier` and friends are not. */
const modelStrings = (dict: Record<string, string>) =>
  Object.entries(dict)
    .filter(([key]) => key.startsWith("alpha.model."))
    .map(([key, value]) => `${key} ${value}`)

describe("#679 平台计价权威棘轮:本地目录不得重新长出价格轴", () => {
  // Premise self-check. A renamed or moved file would otherwise turn every judgement below into a
  // vacuous pass — the "empty gate" failure this repo has already shipped twice.
  test("被扫描的目录面文件都真的存在(改名/移动不得让本闸静默变空)", () => {
    const missing = CATALOG_SURFACE.filter((relative) => !existsSync(join(packageRoot, relative)))
    expect(missing, "扫描清单指向不存在的文件 —— 补进 CATALOG_SURFACE 或改路径").toEqual([])
    expect(CATALOG_SURFACE.length).toBeGreaterThanOrEqual(8)
  })

  test("目录面上没有任何本地价格主张", () => {
    expect(CATALOG_SURFACE.flatMap(scanFile)).toEqual([])
  })

  test("alpha-models.json 结构上就没有价格轴:无 tiers 块、无逐模型 tier、也不含 pricing", () => {
    // 数据层单独钉一次:正则读的是文本,这条读的是解析后的结构 —— 两种读法一起错的概率低得多。
    const catalog = JSON.parse(readFileSync(join(packageRoot, "src/main/alpha-models.json"), "utf8")) as {
      tiers?: unknown
      defaultPlatformModel?: unknown
      platformModels: Array<Record<string, unknown>>
    }
    expect(catalog.tiers).toBeUndefined()
    expect(catalog.platformModels.length).toBeGreaterThan(0)
    for (const model of catalog.platformModels) {
      expect(Object.keys(model), String(model.id)).not.toContain("tier")
      // 本地目录**永远不产出** pricing:它只能来自网关快照(ADR-039)。
      expect(Object.keys(model), String(model.id)).not.toContain("pricing")
    }
    // 平台默认必须是显式声明(而不是靠挑选)—— 这是删掉档位兜底之后唯一剩下的旋钮。
    expect(typeof catalog.defaultPlatformModel === "string" || catalog.defaultPlatformModel === null).toBe(true)
  })

  test("alpha.model.* 文案里没有档位词、也没有写死的倍数", () => {
    const offenders = [
      ...modelStrings(zh).map((entry) => ({ locale: "zh", entry })),
      ...modelStrings(en).map((entry) => ({ locale: "en", entry })),
    ].flatMap(({ locale, entry }) =>
      priceClaimsIn(entry, { stripComments: false }).map((rule) => `${locale} ${entry} → ${rule}`),
    )
    expect(offenders).toEqual([])
    // 前提自检:限定前缀之后还得真的扫到东西,否则这条是空绿。
    expect(modelStrings(zh).length).toBeGreaterThan(20)
    expect(modelStrings(zh).length).toBe(modelStrings(en).length)
  })
})

// ── 扫描器自测。正则写错的棘轮报零违例,看起来和通过一模一样。 ────────────────────────────
describe("#679 棘轮的扫描器自己咬得动(否则它是个空闸)", () => {
  test.each([
    ["恢复 tiers 块", '"tiers": { "std": { "mult": "×1" } }', "local pricing tier axis (deleted in #679)"],
    ["逐模型 tier 字段", '{ "id": "claude-fable-5", "tier": "flag" }', "local pricing tier axis (deleted in #679)"],
    ["Tier 类型回来", 'export type Tier = "flag" | "pro" | "std"', "local pricing tier axis (deleted in #679)"],
    ["mult 字段回来", "const mult = rung.mult", "local pricing multiplier field (deleted in #679)"],
    ["档位 id 当字面值", 'const fallback = "std"', "pricing rung id as a literal value"],
    ["中文档位标签", 'const label = "旗舰"', "pricing rung label (标准/高级/旗舰)"],
    ["新式写死倍数", 'const note = "71.4×"', "hardcoded numeric multiplier"],
    ["旧式写死倍数", 'const note = "×8"', "hardcoded numeric multiplier"],
  ])("咬得动:%s", (_shape, source, rule) => {
    expect(priceClaimsIn(source, { stripComments: true })).toContain(rule)
  })

  test("本票删掉的那行兜底,原样放回去就是红的(这条就是「自己绕一遍」的机器版)", () => {
    // `alpha-live-allowlist.ts` 的投影里曾经有这一行,它是「未收录模型显示标准 ×1」的直接成因。
    const restored = `
      return {
        id: remote.id,
        name: meta?.name ?? remote.id,
        tier: meta?.tier ?? ("std" as const),
        pricing: remote.pricing,
      }
    `
    expect(priceClaimsIn(restored, { stripComments: true })).toEqual(
      expect.arrayContaining([
        "local pricing tier axis (deleted in #679)",
        "pricing rung id as a literal value",
      ]),
    )
  })

  test.each([
    ["真实模型 id deepseek-v4-pro", '{ "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }'],
    ["provider / 复合词不该被误伤", "const provider = catalog.platformProvider; const flagship = false"],
    ["运行时插值的倍数模板不是写死的价格", '"alpha.model.pricingPair": "输入 {{input}}× · 输出 {{output}}×"'],
    ["英文模板同理", '"alpha.model.pricingPair": "In {{input}}× · Out {{output}}×"'],
    ["不可用文案里既没数字也没档位词", '"alpha.model.pricingUnavailable": "计价信息暂不可用"'],
  ])("不误伤:%s", (_shape, source) => {
    expect(priceClaimsIn(source, { stripComments: false })).toEqual([])
  })

  test("注释里的历史说明不算违例(本闸判代码与数据,不判散文)", () => {
    const prose = `
      // 此前本地写死 std / pro / flag 三档,旗舰显示 ×8 —— #679 删除。
      /** tiers 与 mult 都已消失,倍数只由网关下发。 */
      export const noop = 1
    `
    expect(priceClaimsIn(prose, { stripComments: true })).toEqual([])
    // 反面:同样的文字**不当注释**读时必须被咬到 —— 证明上一条绿是剥注释剥出来的,不是正则瞎了。
    expect(priceClaimsIn(prose, { stripComments: false }).length).toBeGreaterThan(0)
  })
})
