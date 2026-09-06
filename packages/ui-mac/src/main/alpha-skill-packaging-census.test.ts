// `#1250`(REQ-153 附带 bug)—— 「随包发出去的技能资产必须有人能装载它」这条保证的闸门。
//
// 这一类缺陷比缺失更贵:看目录会以为它在。所以判据不能是散文枚举(枚举对新成员默认放行),
// 只能派生自**通道本身**。alpha 今天有且只有两条通道,两条都在本文件里被当作权威读取:
//
//   通道 A —— **出厂注入**(零用户动作)。`factorySkillSources()` 是唯一权威:main 在启动时
//     算好 → `reconcileFactorySkills().paths` → env `ALPHA_FACTORY_SKILL_DIRS` →
//     `packages/ext/src/factory-paths.ts` 内存注入 `cfg.skills.paths` → 引擎
//     `skill/index.ts:211-220` 扫描。
//   通道 B —— **定制中心按需安装**(Extension Hub E1b,ADR-014)。catalog 条目的
//     `installSpec.source === "builtin"` + `builtinAssetKey: "skills/<name>"` →
//     `ext-install-planner.ts:888` 的 builtin 分支 → `collectBuiltinSkillPayload` /
//     `installBuiltinSkill`(`ext-fs-installer.ts:306-339`)→ 复制进
//     `<alphaGlobalRoot>/skills/<name>` → `engine-config-truth.ts` 的 `ensureSkillsPath`
//     把那个目录写进 alpha.jsonc 的 `skills.paths` → 同一个引擎扫描。
//
// `#1250` 的票面前提是「`resources/skills/` 不在 `ALPHA_FACTORY_SKILL_DIRS` 里 ⇒ 二者永不装载」。
// 前半句为真,后半句为假:那两个技能走的是通道 B(`skill-creator` 也一样,`factory-skills.ts`
// 抬头的「资产两处」说的就是这件事)。本文件把「哪条通道覆盖了谁」变成一个每次跑都会算的事实,
// 而不是一个要靠人记得去重新推导的结论。
//
// 删掉本文件会失去什么:往 `resources/{skills,factory-skills}/` 放一个目录、既不登记进
// `factorySkillSources()` 又不被任何 catalog 条目引用,可以一路绿到发版 —— 它会被打进安装包
// (electron-builder 对这两个目录是整目录 `extraResources`),占体积,一次都用不上。
// 反方向同样:catalog 里一个 `builtinAssetKey` 指向不存在的资产 = 安装恒失败(REQ-044 实锤过)。

import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import rawCatalog from "../renderer/extensions/alpha-catalog.json"
import { installableCatalogEntries } from "../renderer/extensions/catalog-installable-view"
import type { Catalog } from "../renderer/extensions/catalog-types"
import { factorySkillSources } from "./factory-skills"

const UI_MAC = resolve(import.meta.dir, "..", "..")
const RESOURCES = join(UI_MAC, "resources")
const SKILL_ROOTS = ["skills", "factory-skills"] as const

const catalog = rawCatalog as unknown as Catalog

/** 磁盘上真正随包发出去的每一个技能目录(fs 派生,不枚举名字)。 */
function shippedSkillDirs(): Array<{ id: string; root: string; name: string; dir: string }> {
  const out: Array<{ id: string; root: string; name: string; dir: string }> = []
  for (const root of SKILL_ROOTS) {
    const base = join(RESOURCES, root)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      out.push({ id: `${root}/${entry.name}`, root, name: entry.name, dir: join(base, entry.name) })
    }
  }
  return out
}

/** 通道 A 的权威:出厂注入组(dev 布局 = 仓内 resources/)。 */
function factoryInjectedDirs(): Map<string, string> {
  return new Map(Object.entries(factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(UI_MAC, "out", "main") })))
}

/** 通道 B 的权威:catalog 里仍可安装、且以内置资产安装的 skill 条目。 */
function catalogBuiltinSkillKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  for (const entry of installableCatalogEntries(catalog.entries)) {
    if (entry.type !== "skill") continue
    const spec = entry.installSpec as { kind?: string; source?: string; builtinAssetKey?: string } | undefined
    if (spec?.kind !== "skill" || spec.source !== "builtin" || !spec.builtinAssetKey) continue
    keys.set(spec.builtinAssetKey, entry.id)
  }
  return keys
}

describe("#1250 随包技能资产的可达性普查", () => {
  const shipped = shippedSkillDirs()
  const injected = factoryInjectedDirs()
  const injectedDirs = new Set(injected.values())
  const builtinKeys = catalogBuiltinSkillKeys()

  test("普查对象非空(空集合会让下面每一条都恒绿)", () => {
    expect(shipped.length).toBeGreaterThan(0)
    expect(injected.size).toBeGreaterThan(0)
    expect(builtinKeys.size).toBeGreaterThan(0)
  })

  for (const skill of shippedSkillDirs()) {
    test(`${skill.id} 至少有一条装载通道`, () => {
      const viaFactory = injectedDirs.has(skill.dir)
      const viaCatalog = builtinKeys.has(`${skill.root}/${skill.name}`)
      const reached = viaFactory || viaCatalog
      expect(
        reached
          ? "ok"
          : `${skill.id} 打进包了但两条通道都够不着:既不在 factorySkillSources()(出厂注入),` +
            `也没有任何 catalog 条目以 builtinAssetKey 引用它(定制中心安装)。` +
            `要么登记一条通道,要么从 resources/ 移出去。`,
      ).toBe("ok")
    })
  }

  test("每个技能资产的通道归属逐个点名(读者不必自己去推)", () => {
    const table = shipped
      .map((s) => {
        const channels: string[] = []
        if (injectedDirs.has(s.dir)) channels.push("factory")
        if (builtinKeys.has(`${s.root}/${s.name}`)) channels.push(`catalog(${builtinKeys.get(`${s.root}/${s.name}`)})`)
        return `${s.id} → ${channels.join(" + ")}`
      })
      .sort()
    // 期望值刻意写死:通道归属变化(某个技能改走另一条路、或新增一个技能)必须被人读到 diff,
    // 而不是被一条「每个都至少一条通道」的存在性断言吸收掉。
    expect(table).toEqual([
      "factory-skills/agent-creator → factory",
      "factory-skills/alpha-workspace → factory",
      "factory-skills/cloud-dispatch → factory",
      "factory-skills/customize-alpha → factory",
      "factory-skills/integrate-project → factory",
      "factory-skills/office-docs → factory",
      "skills/alpha-upstream-sync → catalog(skill:alpha-upstream-sync)",
      "skills/safe-refactor → catalog(skill:safe-refactor)",
      "skills/skill-creator → factory + catalog(skill:skill-creator)",
    ])
  })

  test("反向:catalog 引用的每个内置技能资产都真的随包在位(REQ-044 恒失败类)", () => {
    for (const [key, id] of builtinKeys) {
      const dir = join(RESOURCES, key)
      expect(existsSync(dir), `${id} 的 builtinAssetKey=${key} 指向不存在的目录 ⇒ 安装恒失败`).toBe(true)
      expect(existsSync(join(dir, "SKILL.md")), `${id} 的资产缺 SKILL.md ⇒ installBuiltinSkill 会拒`).toBe(true)
    }
  })

  test("出厂注入组的每个源目录都真的在位(缺一个 = 那个技能静默不注入)", () => {
    for (const [name, dir] of injected) {
      expect(existsSync(join(dir, "SKILL.md")), `出厂技能 ${name} 的源 ${dir} 缺 SKILL.md`).toBe(true)
    }
  })
})
