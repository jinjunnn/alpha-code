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
      /用户明确说「用云端」 \| 用云（Word\/Excel\/PPT\/PDF 与网页除外，见下）/,
      /生成、读、改 Word\/Excel\/PPT\/PDF \| 一律用本机 MCP（按 `office-docs` 技能）；文件写进项目目录、不出本机，无云端费用/,
      /生成网页 \/ HTML \| 本机直接写 HTML 文件进项目目录（可自带 CSS 与 JS），在文件面板预览；不派发云端，无云端费用/,
      /生成图片 \| 用云；本机没有图片生成能力/,
      /查一个事实、读一个网页 \| 先用本机搜索\/读取；本机不可用才用 `cloud_web_search` \/ `cloud_web_fetch`/,
      /多来源深度调研 \| 用云端 `research`，做多轮检索与综合/,
      /代码审查 \| 默认本机 agent；用户要求「联网复核」或「第二意见」时用云/,
      /要把本机私有文件传云 \| 先问用户，获得上传授权后才发送内容/,
    ]) expect(cloud.content).toMatch(rule)
  })

  // alpha-platform#552 AC3: cloud office-report is retired; Office files are always made locally.
  test("AC3 Office files go to the local tools and explicit review requests select cloud code-review first", () => {
    expect(cloud.content).toContain("云端 Word/Excel/PPT 生成（`office-report`）已停用：不要派发它，用户明确要求云端时也如实说明")
    expect(cloud.content).toContain("改用本机 `mcp:alpha-word`、`mcp:alpha-excel`、`mcp:alpha-powerpoint`、`mcp:alpha-pdf`")
    expect(cloud.content).toContain("选择云端 `code-review`")
    expect(cloud.content).toContain("不先改成本机搜索或本机代码审查")
    expect(office.content.replace(/\s+/g, " ")).toContain(
      "Cloud Word/Excel/PowerPoint generation (`office-report`) is retired. Do not dispatch it",
    )
    for (const text of [cloud.content, office.content]) {
      expect(text).not.toMatch(/选云端 `office-report`|choose cloud `office-report`|`office-report` pipeline/)
    }
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

  // REQ-236 #1551 AC8:kind 与 input 只读 cloud_dispatch 的工具说明(不再手抄表);下载归宿主,模型不报保存。
  test("AC8 cloud dispatch points at the tool description and the host owns the download", () => {
    for (const instruction of [
      "可用的 `kind` 与每个 kind 的 `input` 字段以 `cloud_dispatch` 的工具说明为准",
      "`cloud_await` 等待，或用 `cloud_status` 查状态",
      "`cloud_artifacts` 获取产物描述符",
      "产物字节不内联返回；需由宿主通过 `contentRef.url` 鉴权下载",
      "产物由宿主下载到本机并核对",
      "不要自行声称文件已保存或已下载，也不要给出保存路径",
      "失败、取消或超时要报告真实状态与错误",
    ]) expect(cloud.content).toContain(instruction)
    expect(cloud.content).not.toMatch(/^\|\s*kind\s*\|/m)
    expect(cloud.content).not.toContain("| `image-generation` |")
    expect(cloud.content).not.toContain("| `office-report` |")
    expect(cloud.content).not.toContain("给出实际路径")
  })

  // alpha-platform#552 AC4: web pages are written locally; no shipped skill steers them to cloud html-generate.
  test("AC4 web pages are written locally and no factory skill steers them to cloud html-generate", async () => {
    expect(cloud.content).toContain("网页 / HTML 由本机直接写文件：不要派发云端 `html-generate`，用户明确要求云端时也如实说明并改为本机生成")
    const files = await Glob.scan("**/SKILL.md", { cwd: join(dev["cloud-capabilities"], ".."), absolute: true, include: "file", symlink: true })
    expect(files).toContain(join(dev["office-docs"], "SKILL.md"))
    for (const file of files) {
      const text = await Bun.file(file).text()
      expect(text).not.toContain("| `html-generate` |")
      expect(text).not.toMatch(/网页[^|\n]*\| 用云端/)
      expect(text).not.toMatch(/HTML 使用托管执行|从零生成网页/)
    }
  })

  test("AC2 office-docs creates, reads and edits every office file locally", () => {
    const text = office.content.replace(/\s+/g, " ")
    for (const instruction of [
      "**Create, read or edit Word/Excel/PowerPoint/PDF with Alpha's four first-party local stdio MCP connectors below**",
      "`mcp:alpha-word`, `mcp:alpha-excel`, `mcp:alpha-powerpoint` and `mcp:alpha-pdf`",
      "They write the file straight into the project directory",
      "the file stays on this machine, with no cloud charge",
      "also when the user asks for the cloud: say it is no longer offered and do the job with the local tools",
      "write what the connector supports, say plainly which parts are missing, and offer a local script (below) for those parts with the user's consent",
    ]) expect(text).toContain(instruction)
    expect(text).not.toContain("Load `cloud-capabilities`")
  })
})
