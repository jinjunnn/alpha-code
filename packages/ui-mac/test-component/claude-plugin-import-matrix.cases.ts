// REQ-128 Phase 3 `[T5-verify]`(#783):本地导入矩阵 —— 真实语料回归夹具的**收口层**。
//
// 与 `claude-plugin-intake.test.ts`(T1 `#780`)的分工:
//   · T1 那份钉的是**每一道闸各自成立**(逐条原因码、合成负向夹具)。
//   · 本份钉的是**三个合成数字与它们的口径**,以及三件 T1 没有回归断言的事:
//     ① 「有技能的插件」的分母到底是多少(基线 §3.2/§3.6 记 40,实测 37 / 38);
//     ② `.bak` 目录必须与普通目录**逐字段同待**(基线 §3.1 明令夹具不许依赖「排除 .bak」);
//     ③ 哪几道闸的**真实语料半场是恒真式** —— 把「恒真」这件事本身钉成可执行事实,
//        否则下一轮 review 会把 `0 fail` 读成「这道闸验过了」。
//
// **计数与成员分开断言**。只断言 `toBe(18)` 杀不掉一个"换了三个成员但总数还是 18"的改动
// (假闸形态⑨:期望值恰好等于一个可硬编码的常量)。所以每个数字都配一份**逐个点名**的成员集。

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { materializeCorpus, pluginRootsIn, skillMdFilesIn } from "./claude-plugin-corpus.fixture"
import { intakeImportDir, previewLocalClaudePlugin, type LocalPackagePreviewV1 } from "../src/main/claude-plugin-intake"

const corpus = materializeCorpus()
afterAll(corpus.cleanup)

const rel = (abs: string): string => path.relative(corpus.root, abs)
const pluginRoots = pluginRootsIn(corpus.root)
const previews = pluginRoots.map((r) => ({ rel: rel(r), preview: previewLocalClaudePlugin(r) }))
const allComponents = previews.flatMap((x) => x.preview.components.map((c) => ({ ...c, plugin: x.rel })))
const componentKey = (c: { plugin: string; dir: string }): string => `${c.plugin}/${c.dir}`

function previewOf(relPath: string): LocalPackagePreviewV1 {
  const found = previews.find((x) => x.rel === relPath)
  if (!found) throw new Error(`语料里没有这个插件根:${relPath}`)
  return found.preview
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// 一、三个合成数字 —— 每个都配一份逐个点名的成员集
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("AC5/AC6 真实语料三个合成数字(基线 §3.6)", () => {
  test("可装 132 —— 分母是 159 份**支持布局**的 SKILL.md,不是 162", () => {
    expect(skillMdFilesIn(corpus.root).length).toBe(162)
    expect(allComponents.length).toBe(159)
    expect(previews.reduce((n, x) => n + x.preview.installableCount, 0)).toBe(132)
    expect(allComponents.filter((c) => c.disposition === "skip").length).toBe(27)
    // 基线 §3.6 记的 135 = `162 − 27`,即把**三份异常布局的 SKILL.md 也算进了分母**。
    // 那三份(receipts / session-report 的 manifestless、msft-365-install 的 .claude/skills)
    // 正是 G18 具名为「不支持的布局」的,结构上装不了 ⇒ 真正可装的是 132。
    // 两条恒等式都钉住:132 是真值,135 只是基线那条算法的复现。
    expect(skillMdFilesIn(corpus.root).length - 27).toBe(135)
    expect(162 - 159).toBe(3)
  })

  test("「有技能的插件」的分母:intake 口径 37 / 路径归属口径 38 —— **都不是基线记的 40**", () => {
    // 基线 §3.2 写「按路径归属数得到 40 个 owner,两轴差 3,差的正好是那 3 个异常布局」。
    // 实测两轴差 **1**:两份 manifestless 的 SKILL.md **没有任何 plugin.json 祖先**
    // (基线自己的 §3.2 表就是这么写的)⇒ 它们结构上**无法**让 owner 数增加。
    // 能让两轴产生差的只有 `.claude/skills` 那 1 个。
    const withCandidates = previews.filter((x) => x.preview.limits.skillCandidates > 0)
    expect(withCandidates.length).toBe(37)
    expect(previews.filter((x) => x.preview.limits.skillCandidates === 0).length).toBe(25)
    expect(withCandidates.length + 25).toBe(62)

    const owners = new Set<string>()
    let orphans = 0
    for (const md of skillMdFilesIn(corpus.root)) {
      let dir = path.dirname(md)
      let owner: string | null = null
      while (dir.startsWith(corpus.root) && dir !== corpus.root) {
        if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
          owner = dir
          break
        }
        dir = path.dirname(dir)
      }
      if (owner) owners.add(rel(owner))
      else orphans++
    }
    expect(owners.size).toBe(38)
    expect(orphans).toBe(2) // receipts / session-report:无祖先 ⇒ 不属于任何 owner
    expect(owners.size - withCandidates.length).toBe(1) // 两轴差 1,不是 3
    expect(owners.size).not.toBe(40)
    expect(withCandidates.length).not.toBe(40)
  })

  test("10 个插件一个技能都装不上(intake 口径,分母 37)—— 逐个点名", () => {
    const dead = previews
      .filter((x) => x.preview.limits.skillCandidates > 0 && x.preview.installableCount === 0)
      .map((x) => x.rel)
      .sort()
    expect(dead).toEqual([
      "claude-plugins-official/external_plugins/discord",
      "claude-plugins-official/external_plugins/imessage",
      "claude-plugins-official/external_plugins/telegram",
      "claude-plugins-official/plugins/claude-security",
      "claude-plugins-official/plugins/hookify",
      "claude-plugins-official/plugins/math-olympiad",
      "claude-plugins-official/plugins/plugin-dev",
      "claude-plugins-official/plugins/project-artifact",
      "claude-plugins-official/plugins/skill-creator",
      "openai-codex/plugins/codex",
    ])
    expect(dead.length).toBe(10)
    // ⚠️ 计数 10 与基线一致,**成员不一致**:基线 §3.6 的名单里有
    // `claude-for-msft-365-install`(它 0 候选 ⇒ 落在 25 个 0-skill 里,不在这个分母)、
    // **没有** `plugin-dev`(7 个候选全被 §3.4 的自包含判定拒掉)。
    expect(dead).toContain("claude-plugins-official/plugins/plugin-dev")
    expect(dead).not.toContain("claude-for-financial-services/claude-for-msft-365-install")
    expect(previewOf("claude-plugins-official/plugins/plugin-dev").limits.skillCandidates).toBe(7)
    expect(previewOf("claude-for-financial-services/claude-for-msft-365-install").limits.skillCandidates).toBe(0)
  })

  test("18 个技能因不自包含被拒 —— 逐个点名(只断言 18 杀不掉换成员的改动)", () => {
    const notSelf = allComponents
      .filter((c) => c.reasonCodes.some((r) => r.startsWith("not-self-contained-")))
      .map(componentKey)
      .sort()
    expect(notSelf).toEqual([
      "claude-for-financial-services/plugins/agent-plugins/model-builder/skills/dcf-model",
      "claude-for-financial-services/plugins/agent-plugins/pitch-agent/skills/dcf-model",
      "claude-for-financial-services/plugins/vertical-plugins/financial-analysis/skills/dcf-model",
      "claude-for-financial-services/plugins/vertical-plugins/financial-analysis/skills/skill-creator",
      "claude-plugins-official/plugins/claude-security/skills/claude-security",
      "claude-plugins-official/plugins/example-plugin/skills/example-command",
      "claude-plugins-official/plugins/hookify/skills/writing-rules",
      "claude-plugins-official/plugins/math-olympiad/skills/math-olympiad",
      "claude-plugins-official/plugins/mcp-server-dev/skills/build-mcp-app",
      "claude-plugins-official/plugins/plugin-dev/skills/agent-development",
      "claude-plugins-official/plugins/plugin-dev/skills/command-development",
      "claude-plugins-official/plugins/plugin-dev/skills/hook-development",
      "claude-plugins-official/plugins/plugin-dev/skills/mcp-integration",
      "claude-plugins-official/plugins/plugin-dev/skills/plugin-settings",
      "claude-plugins-official/plugins/plugin-dev/skills/plugin-structure",
      "claude-plugins-official/plugins/plugin-dev/skills/skill-development",
      "claude-plugins-official/plugins/skill-creator/skills/skill-creator",
      "openai-codex/plugins/codex/skills/codex-cli-runtime",
    ])
    expect(notSelf.length).toBe(18)
    // 四条臂各自在真实语料里都有实例 —— 任何一条被删掉,上面的成员集立刻少一批。
    const arm = (code: string): number => allComponents.filter((c) => c.reasonCodes.includes(code)).length
    expect(arm("not-self-contained-executable-bit")).toBe(9) // = 基线 §3.4 的「9 个技能目录」
    expect(arm("not-self-contained-plugin-root-variable")).toBe(7)
    expect(arm("not-self-contained-outside-reference")).toBe(4)
    expect(arm("not-self-contained-parent-reference")).toBe(2)
  })

  test("12 个技能因调用控制字段被拒 —— 逐个点名,且 openai-codex/codex 3/3 全灭", () => {
    const ctl = allComponents.filter((c) => c.reasonCodes.includes("control-field-unsupported")).map(componentKey).sort()
    expect(ctl).toEqual([
      "claude-plugins-official/external_plugins/discord/skills/access",
      "claude-plugins-official/external_plugins/discord/skills/configure",
      "claude-plugins-official/external_plugins/imessage/skills/access",
      "claude-plugins-official/external_plugins/imessage/skills/configure",
      "claude-plugins-official/external_plugins/telegram/skills/access",
      "claude-plugins-official/external_plugins/telegram/skills/configure",
      "claude-plugins-official/plugins/claude-security/skills/claude-security",
      "claude-plugins-official/plugins/example-plugin/skills/example-command",
      "claude-plugins-official/plugins/project-artifact/skills/project-artifact",
      "openai-codex/plugins/codex/skills/codex-cli-runtime",
      "openai-codex/plugins/codex/skills/codex-result-handling",
      "openai-codex/plugins/codex/skills/gpt-5-4-prompting",
    ])
    expect(ctl.length).toBe(12)
  })

  test("两类拒绝重叠 3 个 ⇒ 并集 27 —— 重叠的那三个也逐个点名", () => {
    const both = allComponents
      .filter((c) => c.reasonCodes.includes("control-field-unsupported") && c.reasonCodes.some((r) => r.startsWith("not-self-contained-")))
      .map(componentKey)
      .sort()
    expect(both).toEqual([
      "claude-plugins-official/plugins/claude-security/skills/claude-security",
      "claude-plugins-official/plugins/example-plugin/skills/example-command",
      "openai-codex/plugins/codex/skills/codex-cli-runtime",
    ])
    expect(18 + 12 - both.length).toBe(27)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// 二、AC7 `.bak` 是真实可选输入 —— 夹具不许依赖「排除 .bak」
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("AC7 `.bak` 目录与普通目录**逐字段同待**", () => {
  // 为什么必须有这条:本机 `claude-for-financial-services.bak` 是一个真实存在的普通目录
  // (另含 118 份 SKILL.md),用户可以直接在 picker 里选中它。仓内语料夹具由
  // `gen-claude-plugin-corpus-fixture.ts` 生成时**排除**了 `.bak`(那是**语料边界**,基线 §3.1),
  // 但**判定**一旦依赖这个前提就是错的。没有这条回归,加一句 `if (name.endsWith(".bak")) skip`
  // 不会让任何用例变红。

  test("插件根改名成 `<name>.bak` ⇒ 预览逐字段不变", () => {
    const donor = path.join(corpus.root, "tide-plugin")
    const before = previewLocalClaudePlugin(donor)
    const renamed = `${donor}.bak`
    fs.renameSync(donor, renamed)
    try {
      const after = previewLocalClaudePlugin(renamed)
      expect(after.name).toBe(before.name)
      expect(after.packageId).toBe(before.packageId)
      expect(after.disposition).toBe(before.disposition)
      expect(after.installableCount).toBe(before.installableCount)
      expect(after.installableCount).toBeGreaterThan(0) // 真走到了清点,不是两边一起早退
      expect(after.components.map((c) => [c.dir, c.disposition, [...c.reasonCodes].sort()])).toEqual(
        before.components.map((c) => [c.dir, c.disposition, [...c.reasonCodes].sort()]),
      )
    } finally {
      fs.renameSync(renamed, donor)
    }
  })

  test("`.bak` 的 marketplace 根与非 `.bak` 兄弟拿到**同一个**具名布局码", () => {
    const sibling = path.join(corpus.root, "claude-for-financial-services")
    const asBak = `${sibling}.bak`
    const before = intakeImportDir(sibling)
    expect(before.route).toBe("local-claude-plugin")
    const beforeCodes = (before as { preview: LocalPackagePreviewV1 }).preview.unsupportedLayouts.map((l) => l.code).sort()
    expect(beforeCodes).toContain("marketplace-json-only")
    fs.renameSync(sibling, asBak)
    try {
      const after = intakeImportDir(asBak)
      expect(after.route).toBe("local-claude-plugin")
      expect((after as { preview: LocalPackagePreviewV1 }).preview.unsupportedLayouts.map((l) => l.code).sort()).toEqual(beforeCodes)
    } finally {
      fs.renameSync(asBak, sibling)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// 三、G18 的**真实语料**半场(T1 的五条臂全是合成的)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G18 真实语料实例 —— 合成夹具之外,真东西也得拿到具名码", () => {
  test("真实 manifestless:receipts 与 session-report 两个都具名,且**不计成 0-skill**", () => {
    for (const relPath of ["claude-plugins-official/plugins/receipts", "claude-plugins-official/plugins/session-report"]) {
      const intake = intakeImportDir(path.join(corpus.root, relPath))
      expect(intake.route).toBe("local-claude-plugin")
      const preview = (intake as { preview: LocalPackagePreviewV1 }).preview
      expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("manifestless-plugin-dir")
      expect(preview.limits.skillCandidates).toBe(1) // 看得见它有技能 ⇒ 不是「0-skill」也不是「没有 SKILL.md」
    }
  })

  test("真实 `.claude/skills`:msft-365-install 拿到 dot-claude-skills-dir,不是一句「没有 SKILL.md」", () => {
    // 这是 G18 臂② 在真实语料里的**唯一**实例,而 T1 只有合成版。
    // 它 `skillCandidates === 0` ⇒ 会落进「25 个 0-skill 插件」那一格;区分它与真 0-skill 的
    // **只有** `unsupportedLayouts` 这一栏。这条断言就是防止那一栏被折叠掉。
    const preview = previewOf("claude-for-financial-services/claude-for-msft-365-install")
    expect(preview.limits.skillCandidates).toBe(0)
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("dot-claude-skills-dir")
    expect(preview.unsupportedLayouts.find((l) => l.code === "dot-claude-skills-dir")!.at).toBe(".claude/skills/verify")
    expect(previews.filter((x) => x.preview.unsupportedLayouts.some((l) => l.code === "dot-claude-skills-dir")).length).toBe(1)
  })

  test("真实 marketplace-only:三个 marketplace 根各自具名", () => {
    const roots = ["claude-for-financial-services", "claude-plugins-official", "openai-codex"]
    for (const r of roots) {
      const intake = intakeImportDir(path.join(corpus.root, r))
      expect(intake.route).toBe("local-claude-plugin")
      expect((intake as { preview: LocalPackagePreviewV1 }).preview.unsupportedLayouts.map((l) => l.code)).toContain("marketplace-json-only")
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// 四、把「真实语料半场是恒真式」钉成可执行事实
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("恒真式登记:这些闸的真实语料半场**不提供任何证据**", () => {
  // 基线 §12 风险 6 点名了三处(G11 的 65 项 / G16 的 symlink 臂 / G18 的根级 SKILL.md 臂)。
  // 实测判据语料(marketplaces,排除 .bak)上恒真的是 **六处** —— 另三处基线各自都写了
  // 「本机 0 例」,但没有把它们登记进那份风险清单,于是下一轮 review 很容易把
  // 「真实语料全过」当成这些臂验过了。
  //
  // 这个 describe 里每条断言的**期望值都是 0**。它证明的不是闸门有效,恰恰相反:
  // 它证明**真实语料对这几条臂什么都没说**。真正的证据在 `claude-plugin-intake.test.ts`
  // 的合成夹具里,本表的「谁验的」一栏逐条指到那里
  // (`docs/verification/2026-08-02-req128-phase3-gate-bypass-matrix.md`)。

  const layoutHits = (code: string): number => previews.filter((x) => x.preview.unsupportedLayouts.some((l) => l.code === code)).length
  const reasonHits = (code: string): number => allComponents.filter((c) => c.reasonCodes.includes(code)).length

  test("基线点名的三处:G11 上限 / G16 symlink 臂 / G18 根级 SKILL.md 臂 —— 真实语料命中 0", () => {
    expect(previews.filter((x) => x.preview.blockedReasonCode === "package-component-limit-exceeded").length).toBe(0)
    expect(Math.max(...previews.map((x) => x.preview.limits.skillCandidates))).toBe(13) // 真界 64,最大 13 ⇒ 结构上撞不上
    expect(reasonHits("not-self-contained-symlink")).toBe(0)
    expect(layoutHits("plugin-root-is-skill")).toBe(0)
  })

  test("基线**没有**点名、但同样恒真的三处 —— 真实语料命中 0", () => {
    // ① G18 臂③ `workflow-skills`:基线 §3.2 记了 4 个实例,但那 4 个全在 `cache` 里,
    //    而 §3.1 已把 cache 排除出判据语料 ⇒ 在判据语料上它是 0 例。
    expect(layoutHits("non-standard-skill-dir")).toBe(0)
    // ② G18 臂⑥ `plugin.json.skills`:基线 §3.2 第 2 条自己实测 183 份 manifest 里 0 次。
    expect(layoutHits("manifest-declared-skills-field")).toBe(0)
    // ③ G16 的 §14 R2-a 臂(技能目录内含 node_modules/.git/__pycache__):基线 §14 自测 0 命中。
    expect(reasonHits("not-self-contained-excluded-directory")).toBe(0)
  })
})
