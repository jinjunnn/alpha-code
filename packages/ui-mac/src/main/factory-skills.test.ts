// REQ-036/REQ-052/REQ-065 — factory skills reconcile (pure fs logic on temp dirs).
// REQ-065 形态的 load-bearing 用例:存量 .alpha 出厂链拆除(T2)+ 注入组计算(T1 的输入)、
// 幂等、绝不动用户内容、同名遮蔽不注入(防引擎双源)、REQ-059 逃生门不拆不改、
// legacy `~/.opencode/skill/` 直链清理。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigMarkdown } from "../../../core/src/config/markdown"
import { Glob } from "../../../core/src/util/glob"
import { FACTORY_SKILL_IDS, factorySkillIds, factorySkillSources, isAlphaFactoryLink, reconcileFactorySkills } from "./factory-skills"
import { CLOUD_MCP_TOOLS } from "./fixtures/cloud-mcp-tools"
import { classifySkill } from "./alpha-skill-placeholder"

let tmp: string
let home: string
let res: string
let sources: Record<string, string>
let roots: { alphaRoot: string; opencodeHome: string }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-factory-"))
  home = join(tmp, "home")
  res = join(tmp, "app", "resources")
  mkdirSync(join(res, "skills", "skill-creator"), { recursive: true })
  writeFileSync(join(res, "skills", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n")
  // 夹具从名单派生(REQ-071 教训:写死清单会在每次新增出厂技能时假红)
  for (const n of FACTORY_SKILL_IDS.filter((x) => x !== "skill-creator")) {
    mkdirSync(join(res, "factory-skills", n), { recursive: true })
    writeFileSync(join(res, "factory-skills", n, "SKILL.md"), `---\nname: ${n}\n---\n`)
  }
  mkdirSync(home, { recursive: true })
  sources = factorySkillSources({ packaged: true, resourcesPath: res, moduleDir: "/nope" })
  roots = { alphaRoot: join(home, ".alpha"), opencodeHome: join(home, ".opencode") }
})
afterEach(() => {
  delete process.env.ALPHA_FACTORY_SKILLS_DISABLE
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT
  rmSync(tmp, { recursive: true, force: true })
})

// 旧真源位(.alpha/skills,REQ-052 遗留)/ 旧直链位(.opencode/skill,REQ-036 初版)
const truthPath = (name: string) => join(home, ".alpha", "skills", name)
const legacyPath = (name: string) => join(home, ".opencode", "skill", name)

describe("factorySkillSources", () => {
  test("#1532 AC5: customization teaches search, confirmation, availability and project trust", () => {
    const text = readFileSync(join(import.meta.dir, "../../resources/factory-skills/customize-code-puppy/SKILL.md"), "utf8")
    for (const sentence of [
      "Search first with `hub_search`",
      "offers skills, agents, commands, connectors (MCP), bundles, and cloud capabilities",
      "Explain what to install and why, then call `hub_install`",
      "app's confirmation box (软件弹出的确认框)",
      "If a key is needed, the user enters it in that box",
      "Never ask for or accept keys in chat; never invent or guess keys for the user",
      "Check `hub_status` before use",
      "For `submitted; result pending` or `reload-pending`, check\n   `hub_status` instead of repeating the installation",
      "do not wait inside\n   the current reply for reload",
      "显示可用以后,下一条消息就能用;不用重启",
      "Only promise use from the next message after the state is `available`",
      "`alpha_register` tool only for project scope",
      "Executable connectors stay gated until the user trusts the project",
      "(skills + agents + commands + connectors)",
      "Project `.code-puppy/plugins/*.js` files are loaded and executed with the same permissions as\n  the engine after the user trusts the project",
      "Trust is granted once for the whole project,\n  not per file or per execution",
      "Executable plugins from the catalog are refused (ADR-040)",
    ]) expect(text).toContain(sentence)
  })

  test("#1532 AC5: customization never teaches global config installation or catalog plugins", () => {
    const text = readFileSync(join(import.meta.dir, "../../resources/factory-skills/customize-code-puppy/SKILL.md"), "utf8")
    for (const forbidden of [
      /edit `\$ALPHA_GLOBAL_DIR\/alpha\.jsonc` directly/i,
      /直接编辑[^\n]*alpha\.jsonc/,
      /MCP \+ skills \+ plugins/i,
      /\([^\n)]*\+ plugins\)/i,
      /从目录装插件/,
      /(?:install|installing) (?:executable )?plugins from (?:the )?catalog/i,
      /For connectors\/skills\/agents\/plugins prefer/,
    ]) expect(text).not.toMatch(forbidden)
  })

  test("#1513: shipped customization skill registers only customize-code-puppy", () => {
    const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: import.meta.dir })
    expect(FACTORY_SKILL_IDS).toContain("customize-code-puppy")
    expect(FACTORY_SKILL_IDS).not.toContain("customize-alpha")
    expect(readFileSync(join(dev["customize-code-puppy"], "SKILL.md"), "utf8")).toContain("name: customize-code-puppy\n")
    expect(sources["customize-code-puppy"]).toBe(join(res, "factory-skills", "customize-code-puppy"))
    expect(reconcileFactorySkills(sources, roots).active).toContain("customize-code-puppy")
  })
  test("packaged resolves under resourcesPath; dev under moduleDir/../../resources", () => {
    expect(sources["skill-creator"]).toBe(join(res, "skills", "skill-creator"))
    const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(tmp, "repo/out/main") })
    expect(dev["agent-creator"]).toBe(join(tmp, "repo/resources/factory-skills/agent-creator"))
  })
})

describe("reconcileFactorySkills — REQ-065(.alpha 零出厂件 + 注入组)", () => {
  test("clean env: no .alpha links created, paths point straight at app resources; idempotent", () => {
    const r1 = reconcileFactorySkills(sources, roots)
    expect(r1.paths.sort()).toEqual(Object.values(sources).sort())
    expect(r1.active.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    // 验收核心:~/.alpha 里零出厂件(连目录都不建)
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false)
    const r2 = reconcileFactorySkills(sources, roots)
    expect({ ...r2, paths: [...r2.paths].sort(), active: [...r2.active].sort() }).toEqual({
      paths: Object.values(sources).sort(),
      removed: [],
      migrated: [],
      skipped: [],
      active: [...FACTORY_SKILL_IDS].sort(),
    })
    expect(factorySkillIds().sort()).toEqual([...FACTORY_SKILL_IDS].sort()) // 徽标真相 = 就位名单
  })
  test("T2: dismantles OUR stale .alpha factory links (REQ-052 leftovers) and prunes the emptied dir", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    symlinkSync("/Applications/old.app/Contents/Resources/factory-skills/agent-creator", truthPath("agent-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed.sort()).toEqual(["agent-creator", "skill-creator"]) // 只有这两个有存量链
    expect(existsSync(truthPath("skill-creator"))).toBe(false)
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false) // 空目录顺手清
    expect(r.paths.sort()).toEqual(Object.values(sources).sort()) // 拆后照常注入
  })
  test("NEVER touches a real dir at ~/.alpha/skills (catalog-installed/user content) — factory path yields, no dup source", () => {
    mkdirSync(truthPath("skill-creator"), { recursive: true })
    writeFileSync(join(truthPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("user content"))).toBe(true)
    expect(existsSync(join(truthPath("skill-creator"), "SKILL.md"))).toBe(true) // untouched
    const others = Object.entries(sources).filter(([n]) => n !== "skill-creator").map(([, p]) => p).sort()
    expect(r.paths.sort()).toEqual(others) // 同名让位:不注入 skill-creator
    expect(r.active).not.toContain("skill-creator")
  })
  test("NEVER removes a FOREIGN symlink at ~/.alpha/skills, even with the same name (codex High-1 精神)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), truthPath("skill-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((x) => x.name === "skill-creator" && x.reason.includes("foreign"))).toBe(true)
    expect(readlinkSync(truthPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(r.paths).not.toContain(sources["skill-creator"]) // 目标未知 → 不注入防双源
    expect(r.active).not.toContain("skill-creator") // 徽标不吹牛(codex M4)
  })
  test("missing source is reported honestly, not silently skipped", () => {
    rmSync(join(res, "factory-skills"), { recursive: true })
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "agent-creator" && s.reason.includes("source missing"))).toBe(true)
    expect(r.paths).toEqual([sources["skill-creator"]])
  })
  test("ALPHA_FACTORY_SKILLS_DISABLE: cleanup still runs, injection group empty", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed).toEqual(["skill-creator"]) // 存量链照拆(它们不再有合法形态)
    expect(r.paths).toEqual([])
    expect(r.active).toEqual([])
    expect(factorySkillIds()).toEqual([])
  })
  test("REQ-059 escape hatch (truth channel off): touches NOTHING — no dismantle, no injection (回退保两跳态)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed).toEqual([])
    expect(r.paths).toEqual([])
    expect(readlinkSync(truthPath("skill-creator"))).toBe(sources["skill-creator"]) // 原样保留
    expect(r.skipped.every((s) => s.reason.includes("escape hatch"))).toBe(true)
  })
})

describe("legacy migration — REQ-036 初版 ~/.opencode/skill 直链", () => {
  test("removes OUR legacy direct links (and prunes the emptied dir); injection unaffected", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    symlinkSync(sources["skill-creator"], legacyPath("skill-creator"))
    symlinkSync("/Applications/old.app/Contents/Resources/factory-skills/agent-creator", legacyPath("agent-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.migrated.sort()).toEqual(["agent-creator", "skill-creator"]) // 只有这两个有 legacy 直链
    expect(existsSync(legacyPath("skill-creator"))).toBe(false)
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(false) // 空目录已顺手拆掉
    expect(r.paths.sort()).toEqual(Object.values(sources).sort())
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false) // 不再建任何 .alpha 出厂链
  })
  test("a user's real dir at the legacy path blocks the item (no duplicate-name double source)", () => {
    mkdirSync(legacyPath("skill-creator"), { recursive: true })
    writeFileSync(join(legacyPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("user content"))).toBe(true)
    const others2 = Object.entries(sources).filter(([n]) => n !== "skill-creator").map(([, p]) => p).sort()
    expect(r.paths.sort()).toEqual(others2)
    expect(r.active).not.toContain("skill-creator")
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(true) // 用户目录原样保留
  })
  test("a FOREIGN legacy symlink is left alone and blocks the item", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), legacyPath("skill-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("legacy foreign"))).toBe(true)
    expect(readlinkSync(legacyPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(r.paths).not.toContain(sources["skill-creator"])
  })
})

describe("isAlphaFactoryLink — 自有链判定(同名 + alpha 资源布局)", () => {
  test("dev/packaged 布局命中;同名异布局/异名同布局都不命中", () => {
    expect(isAlphaFactoryLink("/repo/packages/ui-mac/resources/skills/skill-creator", "skill-creator")).toBe(true)
    expect(isAlphaFactoryLink("/Applications/alpha-code.app/Contents/Resources/factory-skills/agent-creator", "agent-creator")).toBe(true)
    expect(isAlphaFactoryLink("/their/skill", "skill-creator")).toBe(false)
    expect(isAlphaFactoryLink("/x/skills/foo", "skill-creator")).toBe(false) // 异名
    expect(isAlphaFactoryLink("/x/resources/skills/other", "skill-creator")).toBe(false)
  })
})

// These assertions guard shipped model instructions, not model behavior (AC3 is a separate live eval).
describe("REQ-233 cloud skill instructions", () => {
  const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: import.meta.dir })
  const cloud = ConfigMarkdown.parse(readFileSync(join(dev["cloud-capabilities"], "SKILL.md"), "utf8"))
  const office = ConfigMarkdown.parse(readFileSync(join(dev["office-docs"], "SKILL.md"), "utf8"))

  test("AC1 ships cloud-capabilities instead of cloud-dispatch, with a discoverable /cloud entry", async () => {
    expect(FACTORY_SKILL_IDS).toContain("cloud-capabilities")
    expect(FACTORY_SKILL_IDS).not.toContain("cloud-dispatch")
    expect(sources["cloud-capabilities"]).toBe(join(res, "factory-skills", "cloud-capabilities"))
    expect(reconcileFactorySkills(dev, roots).active).toContain("cloud-capabilities")
    expect(existsSync(join(dev["cloud-capabilities"], "../cloud-dispatch"))).toBe(false)
    expect(cloud.data.name).toBe("cloud-capabilities")

    // Same recursive scan and frontmatter parser as engine Skill discovery; names become slash commands.
    const entries = await Promise.all(
      (await Glob.scan("**/SKILL.md", { cwd: dev["cloud-capabilities"], absolute: true, include: "file", symlink: true }))
        .map(async (file) => ConfigMarkdown.parse(await Bun.file(file).text())),
    )
    expect(entries.map((entry) => entry.data.name).sort()).toEqual(["cloud", "cloud-capabilities"])
    expect(entries.find((entry) => entry.data.name === "cloud")?.content).toContain("加载并遵循 `cloud-capabilities` 技能")
    expect(entries.every((entry) => !classifySkill(entry.content).placeholder)).toBe(true)
  })

  test("AC1 §2.8 routes explicit cloud, local files, formatted creation, images, facts, research and review", () => {
    for (const rule of [
      /用户明确说「用云端」 \| 用云/,
      /读、改本机已有的 Word\/Excel\/PPT\/PDF \| 用本机 MCP；文件不出本机，无云端费用/,
      /从零生成要排版好看的 Word\/Excel\/PPT\/网页 \| 用云端固定模板与自动校验；派发前告知估价或费用未知/,
      /生成图片 \| 用云；本机没有图片生成能力/,
      /查一个事实、读一个网页 \| 先用本机搜索\/读取；本机不可用才用 `cloud_web_search` \/ `cloud_web_fetch`/,
      /多来源深度调研 \| 用云端 `research`，做多轮检索与综合/,
      /代码审查 \| 默认本机 agent；用户要求「联网复核」或「第二意见」时用云/,
      /要把本机私有文件传云 \| 先问用户，获得上传授权后才发送内容/,
    ]) expect(cloud.content).toMatch(rule)
  })

  test("AC3 formatted creation and explicit review requests select their cloud pipelines first", () => {
    expect(cloud.content).toContain("必须选云端 `office-report`")
    expect(cloud.content).toContain("不要先用本机 `alpha_word_write_docx`、`alpha_excel_write_xlsx`")
    expect(cloud.content).toContain("选择云端 `code-review`")
    expect(cloud.content).toContain("不先改成本机搜索或本机代码审查")
    expect(office.content.replace(/\s+/g, " ")).toContain("choose cloud `office-report` first")
  })

  test("AC1 checks local login before paid cloud, separates estimates from reserves, and explains refusals without retrying", () => {
    for (const instruction of [
      "先调用本机工具 `alpha_cloud_access`",
      "未登录时按返回入口引导登录并停止",
      "调用任何收费云能力之前，先用免费的 `cloud_account_status`",
      "会员额度、钱包可用余额和「额度用完后用余额付」开关",
      "传入目标 `task`",
      "预留额不是报价，也不是费用上限",
      "第一步通过不保证整个任务付得起",
      "派发前告诉用户返回的估价；无法估价时明说「费用事先算不准」",
      "有些费用必须走钱包",
      "预检、派发或后续步骤拒绝时，按返回的拒绝码解释缺什么、怎么解决",
      "`allowance_exhausted` 对应额度耗尽",
      "`wallet_insufficient` 对应钱包不足",
      "按返回建议指向充值或余额支付设置，不反复重试",
      "实际已产生的服务方费用仍可能结算",
      "不能把选用云端当作上传私有文件的授权",
      "代码审查只发送相关 diff，不发送整个仓库",
    ]) expect(cloud.content).toContain(instruction)
  })

  test("AC1 every cloud tool named in shipped instructions exists in the alpha-platform registry snapshot", async () => {
    // Vendor contracts contain artifact/job schemas but no MCP tool registry. The snapshot carries its source SHA.
    const texts = await Promise.all([
      ...await Glob.scan("**/SKILL.md", { cwd: dev["cloud-capabilities"], absolute: true, include: "file", symlink: true }),
      join(dev["office-docs"], "SKILL.md"),
    ].map((file) => Bun.file(file).text()))
    const names = [...new Set(texts.flatMap((text) => text.match(/\bcloud_[a-z][a-z0-9_]*\b/g) ?? []))]
    expect(names).toContain("cloud_account_status")
    expect(names).toContain("cloud_dispatch")
    expect(CLOUD_MCP_TOOLS).toContain("cloud_account_status")
    expect(names.filter((name) => !(CLOUD_MCP_TOOLS as readonly string[]).includes(name))).toEqual([])
    expect(texts.join("\n")).not.toMatch(/schedule_(?:create|list|delete)/)
  })

  test("AC1 Office and HTML use hosted templates and artifacts require authenticated byte download", () => {
    for (const instruction of [
      "Office 与 HTML 使用托管执行、固定模板和自动校验",
      '`office-report` | `{topic, format: "docx" \\| "xlsx" \\| "pptx", data?}`',
      '`html-generate` | `{prompt}`',
      '`image-generation` | `{prompt}`',
      "`cloud_await` 等待，或用 `cloud_status` 查状态",
      "`cloud_artifacts` 获取产物描述符",
      "产物字节不内联返回；需由宿主通过 `contentRef.url` 鉴权下载",
      "下载成功后才声称文件已保存",
      "失败、取消或超时要报告真实状态与错误",
    ]) expect(cloud.content).toContain(instruction)
  })

  test("AC2 office-docs creates formatted files in cloud and reads or edits existing files locally", () => {
    const text = office.content.replace(/\s+/g, " ")
    for (const instruction of [
      "**From scratch, with layout:** generate a formatted Word/Excel/PowerPoint file in the Code Puppy cloud",
      "hosted execution, fixed templates and automatic validation",
      "Load `cloud-capabilities` (also available as `/cloud`)",
      "follow its login, account, estimate and artifact download steps",
      "`office-report` pipeline",
      "Tell the user the estimate before dispatch; if unknown, say 「费用事先算不准」",
      "**Read or edit an existing local Word/Excel/PowerPoint/PDF:** use Alpha's four first-party local stdio MCP connectors",
      "Keep the file local, with no cloud charge",
      "An explicit request to use the cloud selects the cloud path",
      "**Ask before uploading private local files**",
      "For a new formatted document, use the cloud branch above; for an existing local file, offer the fallback script",
    ]) expect(text).toContain(instruction)
  })
})
