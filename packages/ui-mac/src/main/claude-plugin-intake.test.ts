// REQ-128 Phase 3 `[T1-intake]`(#780):本地 Claude 插件读取与安装预览。
//
// 这套件的判据分两层,**分开断言,不混在一起**:
//   · **真实语料层**(仓内夹具,由本机 `~/.claude/plugins/marketplaces` 导出)——回归用。
//   · **合成负向层**——真实语料里 0 例的那几类只能靠它:symlink(全域 0)、
//     根级 SKILL.md(0)、`node_modules` 在技能目录内(0)、65 项超限(真实最大 13)、
//     **只带块式控制字段的技能(0)**。
//     拿「真实语料全过」当这些闸绿了 = 假闸形态⑨(期望值恰好等于可硬编码的常量)。

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { materializeCorpus, pluginRootsIn, skillMdFilesIn, treeFingerprint } from "../../test-component/claude-plugin-corpus.fixture"
import {
  intakeImportDir,
  previewLocalClaudePlugin,
  LOCAL_PACKAGE_MAX_COMPONENTS,
  type LocalPackagePreviewV1,
  type LocalPackageSkipCode,
} from "./claude-plugin-intake"
import { parseSkillFrontmatter } from "./ext-import-validate"

// ── 合成夹具工具 ──────────────────────────────────────────────────────────────────────────

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `alpha-${prefix}-`))
}

function writeSkill(dir: string, name: string, frontmatterExtra = "", body = "# body\n"): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: a ${name} skill\n${frontmatterExtra}---\n\n${body}`)
}

function writeManifest(root: string, name: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, description: `${name} plugin`, ...extra }))
}

function codesOf(preview: LocalPackagePreviewV1, dirName: string): readonly LocalPackageSkipCode[] {
  return preview.components.find((c) => c.dir === `skills/${dirName}`)?.reasonCodes ?? []
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// AC1 — 真实语料全量,断言具体数字
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("AC1 真实语料全量(仓内夹具,不依赖本机路径)", () => {
  const corpus = materializeCorpus()
  afterAll(corpus.cleanup) // 否则每次绿灯运行都在临时目录留下 888 个文件(约 7.9MB)
  const pluginRoots = pluginRootsIn(corpus.root)
  const previews = pluginRoots.map((r) => previewLocalClaudePlugin(r))
  const allComponents = previews.flatMap((p) => p.components)
  const withCode = (code: LocalPackageSkipCode): number => allComponents.filter((c) => c.reasonCodes.includes(code)).length
  const notSelfContained = allComponents.filter((c) => c.reasonCodes.some((r) => r.startsWith("not-self-contained-"))).length

  test("62 个插件 / 162 份 SKILL.md / 其中 159 份在本期支持的布局里", () => {
    expect(pluginRoots.length).toBe(62)
    expect(skillMdFilesIn(corpus.root).length).toBe(162)
    expect(allComponents.length).toBe(159) // intake 只枚举 `<根>/skills/<n>/SKILL.md`
  })

  test("162 份里 161 份 frontmatter 通过;唯一失败者是 math-olympiad(description 读不出)", () => {
    const results = skillMdFilesIn(corpus.root).map((p) => ({ p, r: parseSkillFrontmatter(fs.readFileSync(p, "utf8")) }))
    const failed = results.filter((x) => !x.r.ok)
    expect(results.length - failed.length).toBe(161)
    expect(failed.length).toBe(1)
    expect(failed[0]!.p).toContain("math-olympiad")
    expect(failed[0]!.r.ok === false && failed[0]!.r.reason).toContain("description 缺失")
  })

  test("25 个插件一个技能都没有 —— 全部给具名终态,不是空成功(G13)", () => {
    const zero = previews.filter((p) => p.limits.skillCandidates === 0)
    expect(zero.length).toBe(25)
    for (const p of zero) {
      expect(p.disposition).toBe("blocked")
      expect(p.blockedReasonCode).toBe("no-installable-component")
      expect(p.blockedReason).toBeTruthy()
    }
  })

  test("18 个技能因不自包含被拒(owner 裁决 A / G16)", () => {
    expect(notSelfContained).toBe(18)
  })

  test("12 个技能因调用控制字段被拒,且 openai-codex/codex 3/3 全灭(owner 裁决 C / G17)", () => {
    expect(withCode("control-field-unsupported")).toBe(12)
    const codex = previews.find((p) => p.name === "codex")!
    expect(codex.components.length).toBe(3)
    expect(codex.components.every((c) => c.reasonCodes.includes("control-field-unsupported"))).toBe(true)
    expect(codex.installableCount).toBe(0)
  })

  test("两类拒绝重叠 3 个 ⇒ 并集 27;可装 132(= 159 支持布局 − 27)", () => {
    const both = allComponents.filter((c) => c.reasonCodes.includes("control-field-unsupported") && c.reasonCodes.some((r) => r.startsWith("not-self-contained-")))
    expect(both.length).toBe(3)
    const rejected = allComponents.filter((c) => c.disposition === "skip")
    expect(rejected.length).toBe(27)
    expect(previews.reduce((n, p) => n + p.installableCount, 0)).toBe(132)
    // 基线 §3.6 记的 135 = 162 − 27,即把**三份异常布局的 SKILL.md 也算进了分母**。
    // 那三份由 G18 具名为「不支持的布局」,结构上装不了 ⇒ 真正可装的是 132。
    expect(skillMdFilesIn(corpus.root).length - rejected.length).toBe(135)
  })

  // `#784` R2:显示名的判据是**新加的**,所以必须反向验一遍它没有误伤正常输入 ——
  // 「前提为假的闸门比没有闸门更贵」的反向检查。真实语料 62 个插件,一个都不该被它碰到。
  test("显示名判据对真实语料**零误伤**:每个有 manifest 的插件都拿得到显示名,且没有一条告知", () => {
    const withManifest = previews.filter((p) => p.packageId !== null)
    expect(withManifest.length).toBeGreaterThan(0)
    // 一个都没被丢名字(丢了就会有 notice)。
    expect(withManifest.filter((p) => p.displayName === null)).toEqual([])
    expect(withManifest.filter((p) => p.displayNameNotice !== null)).toEqual([])
    // 而且显示名就是 manifest 里那个名字**原样** —— 没有被截断、没有被改写。
    expect(withManifest.every((p) => p.displayName === p.name)).toBe(true)
    // 可装总数不受影响 —— 与上面那条 132 是同一份语料、同一次清点。
    expect(previews.reduce((n, p) => n + p.installableCount, 0)).toBe(132)
  })

  test("组件类型逐类具名:22 commands / 20 agents / 12 hooks / 22 .mcp.json(G9)", () => {
    const withType = (t: string): number => previews.filter((p) => p.unsupportedComponentTypes.some((u) => u.type === t)).length
    expect(withType("commands")).toBe(22)
    expect(withType("agents")).toBe(20)
    expect(withType("hooks")).toBe(12)
    expect(withType("mcp-config")).toBe(22)
  })

  test("version 是**选填** —— 27/62 的 manifest 没有它,一个都不因此被拒", () => {
    const noVersion = previews.filter((p) => p.version === null)
    expect(noVersion.length).toBe(27)
    expect(noVersion.every((p) => p.packageId !== null)).toBe(true)
    expect(noVersion.some((p) => p.installableCount > 0)).toBe(true)
  })

  test("真实语料没有一个插件撞上 64 上限(最大 13)—— 故这道闸的真半场只能靠合成夹具", () => {
    const max = Math.max(...previews.map((p) => p.limits.skillCandidates))
    expect(max).toBe(13)
    expect(max).toBeLessThan(LOCAL_PACKAGE_MAX_COMPONENTS)
    expect(previews.some((p) => p.blockedReasonCode === "package-component-limit-exceeded")).toBe(false)
  })

  test("packageId 恒为 local: 命名空间", () => {
    expect(previews.every((p) => p.packageId === null || p.packageId.startsWith("local:"))).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// AC9 / G12 — 纯读:执行前后磁盘逐字节不变,且不许有任何写句柄
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("AC9 纯读,零写盘", () => {
  test("对全部 62 个插件跑一遍 intake:整棵语料树逐字节不变", () => {
    const corpus = materializeCorpus()
    try {
      const before = treeFingerprint(corpus.root)
      for (const root of pluginRootsIn(corpus.root)) previewLocalClaudePlugin(root)
      expect(treeFingerprint(corpus.root)).toBe(before)
    } finally {
      corpus.cleanup()
    }
  })

  test("跑 intake 期间 fs 的写面**一次都没被调用**(含 installs.json 所在的任何路径)", () => {
    const corpus = materializeCorpus()
    // `require` 拿到的是 CJS 那一份 module.exports;生产模块的 `import fs from "node:fs"`
    // 落在同一个对象上,故此处替换真的会拦住它。原函数**先存进独立 const** 再替换。
    const nodeFs = require("node:fs") as Record<string, unknown>
    const banned = [
      "writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync",
      "renameSync", "copyFileSync", "writeSync", "truncateSync", "ftruncateSync", "chmodSync", "chownSync",
      "symlinkSync", "linkSync", "utimesSync", "createWriteStream", "cpSync",
    ]
    const saved: Record<string, unknown> = {}
    for (const key of banned) saved[key] = nodeFs[key]
    const originalOpenSync = nodeFs["openSync"] as (...args: unknown[]) => number
    const violations: string[] = []
    for (const key of banned) nodeFs[key] = (...args: unknown[]) => {
      violations.push(`fs.${key}(${String(args[0])})`)
      throw new Error(`零写盘违规:fs.${key}`)
    }
    const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC
    nodeFs["openSync"] = (...args: unknown[]) => {
      const flags = args[1]
      if (typeof flags === "string" && flags !== "r") violations.push(`fs.openSync(flags=${flags})`)
      if (typeof flags === "number" && (flags & WRITE_BITS) !== 0) violations.push(`fs.openSync(flags=${flags})`)
      return originalOpenSync(...args)
    }
    try {
      for (const root of pluginRootsIn(corpus.root)) previewLocalClaudePlugin(root)
      expect(violations).toEqual([])
    } finally {
      for (const key of banned) nodeFs[key] = saved[key]
      nodeFs["openSync"] = originalOpenSync
      corpus.cleanup()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G18 — 布局识别与不支持布局具名(五类各一条)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G18 不支持的布局逐类具名(**不许**落回「文件夹内没有 SKILL.md」)", () => {
  test("① manifestless 插件(receipts 的真实结构):具名 manifestless-plugin-dir,不是 0-skill", () => {
    // 真实结构复制:`plugins/receipts` 没有 .claude-plugin/plugin.json,却有 skills/<n>/SKILL.md,
    // 且是 marketplace.json 里的一等条目。按「有 plugin.json 才是包」的规则会落回单技能路径,
    // 得到一句与真因毫无关系的「文件夹内没有 SKILL.md」。
    const root = tmp("manifestless")
    writeSkill(path.join(root, "skills", "receipts"), "receipts")
    const intake = intakeImportDir(root)
    expect(intake.route).toBe("local-claude-plugin")
    const preview = (intake as { preview: LocalPackagePreviewV1 }).preview
    // 断言的是**原因码**,不是 `ok === false` —— 两条路径都会是 false,只断言 false 是假闸。
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("manifestless-plugin-dir")
    expect(preview.blockedReasonCode).toBe("manifest-unreadable")
    expect(preview.limits.skillCandidates).toBe(1) // 看得见它有技能,不是「0-skill」
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("② .claude/skills/<n>/SKILL.md", () => {
    const root = tmp("dotclaude")
    writeManifest(root, "msft-install")
    writeSkill(path.join(root, ".claude", "skills", "verify"), "verify")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("dot-claude-skills-dir")
    expect(preview.unsupportedLayouts.find((l) => l.code === "dot-claude-skills-dir")!.at).toBe(".claude/skills/verify")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("③ workflow-skills/<n>/SKILL.md 与 skills/ 并存 —— 说清「我枚举了哪个、忽略了哪个」", () => {
    const root = tmp("workflow")
    writeManifest(root, "figma")
    writeSkill(path.join(root, "skills", "figma-use"), "figma-use")
    writeSkill(path.join(root, "workflow-skills", "figma-flow"), "figma-flow")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.unsupportedLayouts.some((l) => l.code === "non-standard-skill-dir" && l.at === "workflow-skills")).toBe(true)
    expect(preview.components.map((c) => c.dir)).toEqual(["skills/figma-use"])
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("④ .claude-plugin/ 里只有 marketplace.json", () => {
    const root = tmp("marketonly")
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
    fs.writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "{}")
    const intake = intakeImportDir(root)
    expect(intake.route).toBe("local-claude-plugin")
    const preview = (intake as { preview: LocalPackagePreviewV1 }).preview
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("marketplace-json-only")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("⑤ 插件根自己就是一个技能(真实语料 0 例,只能合成)", () => {
    const root = tmp("rootskill")
    writeManifest(root, "root-is-skill")
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: root-is-skill\ndescription: d\n---\n")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("plugin-root-is-skill")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("⑥ plugin.json 用 skills 字段声明自定义目录(本机 183 份 manifest 里 0 次)", () => {
    const root = tmp("declared")
    writeManifest(root, "declares", { skills: ["./custom"] })
    writeSkill(path.join(root, "skills", "ok"), "ok")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.unsupportedLayouts.map((l) => l.code)).toContain("manifest-declared-skills-field")
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G16 — 自包含判定(独立 lstat 扫描,含 §14 R2-a)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G16 自包含判定(判据 = 命中特征即拒,**不是**「保证自包含」)", () => {
  test("symlink:真实语料全域 0 例 ⇒ 必须合成。collector 静默丢它,只有独立扫描看得见", () => {
    const root = tmp("symlink")
    writeManifest(root, "sym")
    const dir = path.join(root, "skills", "linky")
    writeSkill(dir, "linky")
    fs.symlinkSync("/etc/passwd", path.join(dir, "escape.txt"))
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "linky")).toContain("not-self-contained-symlink")
    expect(preview.installableCount).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("可执行位:判据是**任一** x 位,不是 u+g+o 全有", () => {
    const root = tmp("execbit")
    writeManifest(root, "exec")
    for (const [name, mode] of [["only-user", 0o744], ["only-other", 0o645], ["all-three", 0o755]] as const) {
      const dir = path.join(root, "skills", name)
      writeSkill(dir, name)
      fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\n")
      fs.chmodSync(path.join(dir, "run.sh"), mode)
    }
    const preview = previewLocalClaudePlugin(root)
    // `-perm -111` 只会抓到 all-three;那条口径会放行前两个。
    for (const name of ["only-user", "only-other", "all-three"]) {
      expect(codesOf(preview, name)).toContain("not-self-contained-executable-bit")
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("§14 R2-a:技能目录内含 node_modules / .git / __pycache__ ⇒ **具名拒绝**", () => {
    // 为什么必须处置:collector(ext-fs-installer 的 collectImportFiles)**必定静默跳过**这三类,
    // 而独立扫描看得见 ⇒ 不具名拒绝就是「预览接受、装完缺件」。真实语料 0 命中,
    // 但用户可以手选**任意**目录 ⇒ 路径可达。
    for (const excluded of ["node_modules", ".git", "__pycache__"]) {
      const root = tmp("excluded")
      writeManifest(root, "excl")
      const dir = path.join(root, "skills", "buildy")
      writeSkill(dir, "buildy")
      fs.mkdirSync(path.join(dir, excluded), { recursive: true })
      fs.writeFileSync(path.join(dir, excluded, "thing.js"), "module.exports = 1\n")
      const preview = previewLocalClaudePlugin(root)
      expect(codesOf(preview, "buildy")).toContain("not-self-contained-excluded-directory")
      expect(preview.installableCount).toBe(0)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("插件根变量 / 兄弟技能引用 / 根解析引用", () => {
    const root = tmp("refs")
    writeManifest(root, "refs")
    writeSkill(path.join(root, "skills", "usesvar"), "usesvar", "", "run ${CLAUDE_PLUGIN_ROOT}/scripts/x.py\n")
    writeSkill(path.join(root, "skills", "sibling"), "sibling", "", "see ../other/references/e.md\n")
    writeSkill(path.join(root, "skills", "other"), "other")
    fs.mkdirSync(path.join(root, "skills", "other", "references"), { recursive: true })
    fs.writeFileSync(path.join(root, "skills", "other", "references", "e.md"), "x")
    writeSkill(path.join(root, "skills", "rootref"), "rootref", "", "read commands/example-command.md\n")
    fs.mkdirSync(path.join(root, "commands"), { recursive: true })
    fs.writeFileSync(path.join(root, "commands", "example-command.md"), "x")
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "usesvar")).toContain("not-self-contained-plugin-root-variable")
    expect(codesOf(preview, "sibling")).toContain("not-self-contained-parent-reference")
    expect(codesOf(preview, "rootref")).toContain("not-self-contained-outside-reference")
    expect(preview.components.find((c) => c.dir === "skills/other")!.disposition).toBe("install")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("功能夹具:一个真会调用支撑脚本的技能 —— 被拒,且原因指向脚本而不是一句「失败」", () => {
    const root = tmp("script")
    writeManifest(root, "scripted")
    const dir = path.join(root, "skills", "runner")
    writeSkill(dir, "runner", "", "执行 scripts/render.sh 生成报告\n")
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(dir, "scripts", "render.sh"), "#!/bin/sh\necho ok\n")
    fs.chmodSync(path.join(dir, "scripts", "render.sh"), 0o755)
    const preview = previewLocalClaudePlugin(root)
    const comp = preview.components.find((c) => c.dir === "skills/runner")!
    expect(comp.disposition).toBe("skip")
    expect(comp.reasonCodes).toContain("not-self-contained-executable-bit")
    expect(comp.reasons.join("")).toContain("可执行")
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G17 — 调用控制字段(含 §14 R2-b:判据是「顶层键在不在」)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G17 调用控制字段具名跳过", () => {
  test("**块式**写法必须被抓到 —— 这是本票的核心风险,真实语料**验不出来**", () => {
    // 为什么必须合成:真实语料里 7 份块式 `allowed-tools:` 全都**同时**带一个标量控制字段
    // (`user-invocable:` / `disable-model-invocation:`),所以按老口径算也是 12。
    // 也就是说,「把口径改回要求有标量值」在真实语料上**不会变红** ——
    // 只用真实语料给这道闸打分就是假闸形态⑨。真正能杀掉它的只有下面这个
    // **唯一控制字段是块式**的技能。
    const root = tmp("blockform")
    writeManifest(root, "blocky")
    writeSkill(path.join(root, "skills", "blockonly"), "blockonly", "allowed-tools:\n  - Read\n  - Bash(ls *)\n")
    writeSkill(path.join(root, "skills", "scalaronly"), "scalaronly", "user-invocable: false\n")
    writeSkill(path.join(root, "skills", "clean"), "clean")
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "blockonly")).toContain("control-field-unsupported")
    expect(codesOf(preview, "scalaronly")).toContain("control-field-unsupported")
    expect(codesOf(preview, "clean")).toEqual([])
    expect(preview.installableCount).toBe(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("判据是**键在不在**,与值无关 —— `user-invocable: true` 同样被拒", () => {
    // 真实语料 10 份 user-invocable 里 7 份是 `true`。把判据改成「值等于 false」
    // 会把这 7 份放行,断言数从 12 掉到 3。
    const root = tmp("truthy")
    writeManifest(root, "truthy")
    writeSkill(path.join(root, "skills", "yes"), "yes", "user-invocable: true\n")
    expect(codesOf(previewLocalClaudePlugin(root), "yes")).toContain("control-field-unsupported")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("四个控制字段逐个成立", () => {
    for (const line of ["allowed-tools: [Read]", "argument-hint: <x>", "disable-model-invocation: true", "user-invocable: false"]) {
      const root = tmp("ctrl")
      writeManifest(root, "ctrl")
      writeSkill(path.join(root, "skills", "s"), "s", `${line}\n`)
      expect(codesOf(previewLocalClaudePlugin(root), "s")).toContain("control-field-unsupported")
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("**不解析嵌套**:缩进的同名键不是顶层键,不得误报", () => {
    const root = tmp("nested")
    writeManifest(root, "nested")
    writeSkill(path.join(root, "skills", "deep"), "deep", "metadata:\n  allowed-tools: [Read]\n")
    expect(codesOf(previewLocalClaudePlugin(root), "deep")).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G11 — 事务规模界(真界 64,不是发布端的 16)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G11 组件数上限 = 事务真界 64", () => {
  // 表驱动:只有 64/65 两点的闸,一个写死 `count === 65` 的错误实现可以全绿 ——
  // 66 个照报可装,到确认才撞事务硬上限(假闸形态⑨)。故正边界与负向各取多点。
  test.each([
    [1, "installable"],
    [63, "installable"],
    [64, "installable"],
    [65, "blocked"],
    [66, "blocked"],
    [200, "blocked"],
  ] as const)("%i 个技能 ⇒ %s", (count, expected) => {
    const root = tmp(`bound${count}`)
    writeManifest(root, `bound${count}`)
    for (let i = 0; i < count; i++) writeSkill(path.join(root, "skills", `s${i}`), `s${i}`)
    const preview = previewLocalClaudePlugin(root)
    expect(preview.limits.skillCandidates).toBe(count)
    expect(preview.disposition).toBe(expected)
    if (expected === "blocked") {
      expect(preview.blockedReasonCode).toBe("package-component-limit-exceeded")
      expect(preview.installableCount).toBe(0)
      expect(preview.components.length).toBe(count) // 不是 slice(0, 64)
      for (const c of preview.components) expect(c.reasonCodes).toEqual(["package-component-limit-exceeded"])
    } else {
      expect(preview.installableCount).toBe(count)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("65 个技能 ⇒ preview 期整包具名拒绝,且**一个技能都没被采集**", () => {
    const root = tmp("limit")
    writeManifest(root, "toobig")
    for (let i = 0; i < 65; i++) writeSkill(path.join(root, "skills", `s${i}`), `s${i}`)
    // 埋一个「载荷必然读不出」的技能:SKILL.md 超过 256KB 帽(仍是合法候选,frontmatter 也合法)。
    // 若上限判断被挪到采集之后(或改成 slice(0,64)),这一个会额外带上 payload-unreadable ⇒ 红。
    fs.writeFileSync(path.join(root, "skills", "s0", "SKILL.md"), `---\nname: s0\ndescription: d\n---\n${"x".repeat(300 * 1024)}`)
    const preview = previewLocalClaudePlugin(root)
    expect(preview.limits.skillCandidates).toBe(65)
    expect(preview.limits.maxComponents).toBe(64)
    expect(preview.disposition).toBe("blocked")
    expect(preview.blockedReasonCode).toBe("package-component-limit-exceeded")
    expect(preview.installableCount).toBe(0)
    expect(preview.components.length).toBe(65) // 不是 slice(0,64)
    for (const c of preview.components) expect(c.reasonCodes).toEqual(["package-component-limit-exceeded"])
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// owner 裁决 D — 重名(纯函数半场;生产可达性由 claude-plugin-intake.ipc.test.ts 钉)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("owner 裁决 D 重名", () => {
  test("与本机已装技能重名 ⇒ 具名跳过(判据用 frontmatter 的 name,不是目录名)", () => {
    const root = tmp("collide")
    writeManifest(root, "collide")
    // 目录名 dirname-differs,frontmatter name = taken —— 落盘的键是后者。
    writeSkill(path.join(root, "skills", "dirname-differs"), "taken")
    writeSkill(path.join(root, "skills", "free"), "free")
    const preview = previewLocalClaudePlugin(root, { installedSkillNames: new Set(["taken"]) })
    expect(codesOf(preview, "dirname-differs")).toContain("name-collision-installed")
    expect(codesOf(preview, "free")).toEqual([])
    expect(preview.installableCount).toBe(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("包内两个目录解析出同一个 name ⇒ **两个都跳过**(不挑赢家)", () => {
    const root = tmp("dupname")
    writeManifest(root, "dupname")
    writeSkill(path.join(root, "skills", "alpha-dir"), "same-name")
    writeSkill(path.join(root, "skills", "beta-dir"), "same-name")
    writeSkill(path.join(root, "skills", "unique"), "unique")
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "alpha-dir")).toEqual(["name-collision-in-package"])
    expect(codesOf(preview, "beta-dir")).toEqual(["name-collision-in-package"])
    expect(preview.installableCount).toBe(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("已被别的原因拒掉的组件不参与包内重名计数(不给与真因无关的原因)", () => {
    const root = tmp("dupskip")
    writeManifest(root, "dupskip")
    writeSkill(path.join(root, "skills", "ok-one"), "twin")
    writeSkill(path.join(root, "skills", "ctrl-one"), "twin", "user-invocable: false\n")
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "ctrl-one")).toEqual(["control-field-unsupported"])
    expect(codesOf(preview, "ok-one")).toEqual([]) // 另一个已被拒 ⇒ 这个不再算重名
    expect(preview.installableCount).toBe(1)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G12 — 敌意夹具:载荷读取硬化没有被绕开
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G12 敌意夹具(枚举一律 -a;这些文件在运行期生成,不进版本控制)", () => {
  test("symlink 逃逸出源目录 ⇒ 拒", () => {
    const outside = tmp("outside")
    fs.writeFileSync(path.join(outside, "secret.txt"), "s3cret")
    const root = tmp("escape")
    writeManifest(root, "escape")
    const dir = path.join(root, "skills", "esc")
    writeSkill(dir, "esc")
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "leak.txt"))
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "esc")).toContain("not-self-contained-symlink")
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test("字面 NUL 字节的支撑文件:字节如实流过 collector,不崩、不静默截断", () => {
    const root = tmp("nul")
    writeManifest(root, "nully")
    const dir = path.join(root, "skills", "nul")
    writeSkill(dir, "nul")
    const nulBytes = Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63])
    fs.writeFileSync(path.join(dir, "data.bin"), nulBytes)
    const preview = previewLocalClaudePlugin(root)
    const comp = preview.components.find((c) => c.dir === "skills/nul")!
    expect(comp.disposition).toBe("install")
    expect(comp.fileCount).toBe(2)
    const skillMdSize = fs.statSync(path.join(dir, "SKILL.md")).size
    expect(comp.byteCount).toBe(skillMdSize + nulBytes.length) // 5 字节含 2 个 NUL,一个都没丢
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("**杀掉硬化读取旁路**:SKILL.md frontmatter 正常闭合但文件超 256KB ⇒ 必须被拒", () => {
    // 这一条是 G12 里唯一真能杀掉「把技能读取换成裸 readFileSync」的用例:
    // 裸读会成功、frontmatter 也解析得出来 ⇒ 判成可装;只有走 collector 的 256KB 帽才会拒。
    // (另外三例杀不掉它:symlink 被独立扫描先拒、NUL 对裸读同样保真、超长 frontmatter 由解析器拒。)
    const root = tmp("oversize")
    writeManifest(root, "oversize")
    const dir = path.join(root, "skills", "big")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: big\ndescription: d\n---\n\n${"x".repeat(300 * 1024)}`)
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "big")).toEqual(["payload-unreadable"])
    expect(preview.installableCount).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("**超大 plugin.json** ⇒ 认不出这个插件,而不是把它整份读进 main 内存", () => {
    // manifest 是第三方目录里的文件,和技能载荷一样不可信。此前它走的是裸 readFileSync(无上限)。
    const root = tmp("bigmanifest")
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
    fs.writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "huge", description: "d", pad: "y".repeat(400 * 1024) }),
    )
    writeSkill(path.join(root, "skills", "s"), "s")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.packageId).toBeNull()
    expect(preview.blockedReasonCode).toBe("manifest-unreadable")
    expect(preview.limits.skillCandidates).toBe(1) // 仍看得见有技能,不是「空目录」
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("plugin.json 是 symlink ⇒ 不跟随(与技能载荷同一份硬化原语)", () => {
    const outside = tmp("outside4")
    fs.writeFileSync(path.join(outside, "real.json"), JSON.stringify({ name: "sneak", description: "d" }))
    const root = tmp("manifestlink")
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
    fs.symlinkSync(path.join(outside, "real.json"), path.join(root, ".claude-plugin", "plugin.json"))
    writeSkill(path.join(root, "skills", "s"), "s")
    const preview = previewLocalClaudePlugin(root)
    expect(preview.packageId).toBeNull()
    expect(preview.blockedReasonCode).toBe("manifest-unreadable")
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test("超长 frontmatter(>8192)⇒ frontmatter-unreadable,不是一句泛化失败", () => {
    const root = tmp("longfm")
    writeManifest(root, "longfm")
    const dir = path.join(root, "skills", "long")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: long\ndescription: d\n${"pad: x\n".repeat(2000)}---\n`)
    expect(codesOf(previewLocalClaudePlugin(root), "long")).toContain("frontmatter-unreadable")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("SKILL.md 本身是 symlink ⇒ **具名拒绝**,不是从候选集里消失", () => {
    // 前一版这条断言的是 `skillCandidates === 0` —— 那是**把 bug 写成了期望**:
    // 用户会看到「这个插件没有能装的技能」,而真因是「你用快捷方式摆了技能」。
    const outside = tmp("outside2")
    fs.writeFileSync(path.join(outside, "real.md"), "---\nname: sneaky\ndescription: d\n---\n")
    const root = tmp("smdlink")
    writeManifest(root, "smdlink")
    const dir = path.join(root, "skills", "sneaky")
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(path.join(outside, "real.md"), path.join(dir, "SKILL.md"))
    const preview = previewLocalClaudePlugin(root)
    expect(preview.limits.skillCandidates).toBe(1)
    expect(codesOf(preview, "sneaky")).toEqual(["skill-entry-not-regular"])
    expect(preview.installableCount).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test("技能目录本身是 symlink ⇒ **具名拒绝**(不跟随、也不静默漏掉)", () => {
    const outside = tmp("outside3")
    fs.mkdirSync(path.join(outside, "realskill"), { recursive: true })
    fs.writeFileSync(path.join(outside, "realskill", "SKILL.md"), "---\nname: linked\ndescription: d\n---\n")
    const root = tmp("dirlink")
    writeManifest(root, "dirlink")
    fs.mkdirSync(path.join(root, "skills"), { recursive: true })
    fs.symlinkSync(path.join(outside, "realskill"), path.join(root, "skills", "linked"))
    const preview = previewLocalClaudePlugin(root)
    expect(preview.limits.skillCandidates).toBe(1)
    expect(codesOf(preview, "linked")).toEqual(["skill-entry-not-regular"])
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test("独立扫描失败(深度 33,深层还埋着可执行文件)⇒ **fail-closed** 具名拒绝", () => {
    // 反方向才是真危险:扫不动时「没看见可执行位」不是「没有」,是**没看**。
    const root = tmp("deep")
    writeManifest(root, "deep")
    const dir = path.join(root, "skills", "abyss")
    writeSkill(dir, "abyss")
    let cur = dir
    for (let i = 0; i < 34; i++) {
      cur = path.join(cur, `d${i}`)
      fs.mkdirSync(cur, { recursive: true })
    }
    fs.writeFileSync(path.join(cur, "run.sh"), "#!/bin/sh\n")
    fs.chmodSync(path.join(cur, "run.sh"), 0o755)
    const preview = previewLocalClaudePlugin(root)
    expect(codesOf(preview, "abyss")).toEqual(["self-containment-scan-failed"])
    expect(preview.installableCount).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// AC8 / K19 — 重复导入在**确认之前**说清
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("AC8 重复导入", () => {
  test("已装过同一个包 ⇒ 预览里就说清「先移除整包」,不是等确认之后才撞闸", () => {
    const root = tmp("dup")
    writeManifest(root, "already-here")
    writeSkill(path.join(root, "skills", "s"), "s")
    const fresh = previewLocalClaudePlugin(root)
    expect(fresh.duplicateImportNotice).toBeNull()
    const again = previewLocalClaudePlugin(root, { installedPackageIds: new Set([fresh.packageId!]) })
    expect(again.duplicateImportNotice).toContain("先移除整包")
    fs.rmSync(root, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// 分流点 — 非插件目录的行为逐字不变
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("分流点(main 侧,picker 之后)", () => {
  test("根级 SKILL.md 且无 .claude-plugin ⇒ 原路走单技能导入", () => {
    const root = tmp("single")
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: solo\ndescription: d\n---\n")
    expect(intakeImportDir(root)).toEqual({ route: "single-skill" })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("既没有 SKILL.md 也没有插件标记 ⇒ 原路走单技能导入(错误信息不变)", () => {
    const root = tmp("empty")
    expect(intakeImportDir(root)).toEqual({ route: "single-skill" })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("路径不存在 / 不是绝对路径 ⇒ 原路走单技能导入", () => {
    expect(intakeImportDir("/nope/does/not/exist")).toEqual({ route: "single-skill" })
    expect(intakeImportDir("relative/path")).toEqual({ route: "single-skill" })
  })

  test("真实插件目录 ⇒ 分流到本地包路径", () => {
    const corpus = materializeCorpus()
    try {
      for (const root of pluginRootsIn(corpus.root)) expect(intakeImportDir(root).route).toBe("local-claude-plugin")
    } finally {
      corpus.cleanup()
    }
  })
})
