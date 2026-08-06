// Unit tests for the skill/agent installer (REQ-018 T2 rework). Rejection paths (name/asset-key
// guards) return before disk I/O. Accept paths are now fully testable off-device: the alpha truth
// root and engine bridge root honor ALPHA_GLOBAL_DIR / ALPHA_OPENCODE_HOME test inputs, so real
// writes land in throwaway temp dirs — we assert truth files, bridge symlinks AND receipts.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

mock.module("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {} },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))

const { agentInstallPresent, collectBuiltinAgentPayload, collectVendoredPluginPayload, installBuiltinSkill, removeFsInstall, resourcesRoot, stageVendoredPluginVersioned, writeAgent, writeSkill } = await import("./ext-fs-installer")
const { addReceipt, readLedger } = await import("./alpha-installs")

let base = ""
let alphaDir = ""
let opencodeDir = ""
const prevAlpha = process.env.ALPHA_GLOBAL_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-installer-")))
  alphaDir = path.join(base, "alpha-code-state", "env", "dev")
  opencodeDir = path.join(base, ".opencode")
  fs.mkdirSync(alphaDir, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = alphaDir
  process.env.ALPHA_OPENCODE_HOME = opencodeDir
})
afterEach(() => {
  if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevAlpha
  if (prevHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = prevHome
  fs.rmSync(base, { recursive: true, force: true })
})

describe("writeSkill / writeAgent — name validation blocks traversal (no disk I/O on reject)", () => {
  test.each([["../../etc/passwd"], ["a/b"], [""], ["../evil"], [".hidden"]])(
    "writeSkill rejects unsafe name %p",
    (name) => {
      expect(writeSkill(name, "d", "b")).toEqual({ ok: false, reason: "invalid skill name" })
      expect(fs.existsSync(path.join(alphaDir, "skills"))).toBe(false)
    },
  )

  test.each([["../../etc/passwd"], ["a/b"], [""]])("writeAgent rejects unsafe name %p", (name) => {
    expect(writeAgent(name, "content")).toEqual({ ok: false, reason: "invalid agent name" })
  })
})

describe("writeSkill — global scope writes truth + bridge + receipt", () => {
  test("SKILL.md lands in current-environment skills (engine sees it via skills.paths)", () => {
    const r = writeSkill("my-skill", "does things", "# body")
    expect(r.ok).toBe(true)
    const truth = path.join(alphaDir, "skills", "my-skill", "SKILL.md")
    expect(fs.readFileSync(truth, "utf8")).toContain("does things")
    // T3(REQ-059):skills 桥退役 —— 真源即可,引擎经 alpha.jsonc skills.paths 发现;.opencode 内零 alpha 痕迹
    expect(fs.existsSync(path.join(opencodeDir, "skills"))).toBe(false)
    // receipt
    const { receipts } = readLedger(alphaDir)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ id: "user:my-skill", type: "skill", scope: "global", origin: "created" })
    expect(receipts[0]!.files!.length).toBeGreaterThan(0)
  })

  test("#354:catalog meta 不再在 installer 层落 v1(账本所有权归 planner v2 upsert)", () => {
    const r = writeSkill("cat-skill", "d", "b", { scope: "global" }, { catalogId: "skill:cat-skill", version: "2026-07-03.1" })
    expect(r.ok).toBe(true)
    const { receipts } = readLedger(alphaDir)
    expect(receipts).toHaveLength(0) // eager v1 已下线;v1 视图由 planner upsert 的 toV1Receipt 锁步派生
  })
})

describe("writeAgent — global scope", () => {
  test("T3b:agent md 落当前环境 agents + alpha.jsonc 条目;零 .opencode 桥", () => {
    const r = writeAgent("helper", "---\ndescription: h\nmode: subagent\n---\nsystem")
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(alphaDir, "agents", "helper.md"), "utf8")).toContain("system")
    // 桥退役:引擎经 alpha.jsonc 的 agent.<name> 条目见到(G1 通道),.opencode 内零 alpha 痕迹
    expect(fs.existsSync(path.join(opencodeDir, "agents"))).toBe(false)
    const cfg = JSON.parse(fs.readFileSync(path.join(alphaDir, "alpha.jsonc"), "utf8"))
    expect(cfg.agent.helper).toMatchObject({ description: "h", mode: "subagent", prompt: "system" })
    const { receipts } = readLedger(alphaDir)
    expect(receipts[0]).toMatchObject({ type: "agent", name: "helper" })
  })

  test("T3b fail-closed:frontmatter 转换不了(未知键)→ 拒装,零落盘", () => {
    const r = writeAgent("bad", "---\ndescription: d\nmystery_key: x\n---\nbody")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("mystery_key")
    expect(fs.existsSync(path.join(alphaDir, "agents", "bad.md"))).toBe(false)
  })

  test("T3b:removeFsInstall 净除 alpha.jsonc 条目 + md", () => {
    expect(writeAgent("gone", "---\ndescription: d\n---\nbody").ok).toBe(true)
    const r = removeFsInstall("agent", "gone")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "agents", "gone.md"))).toBe(false)
    const cfg = JSON.parse(fs.readFileSync(path.join(alphaDir, "alpha.jsonc"), "utf8"))
    expect(cfg.agent?.gone).toBeUndefined()
  })
})

describe("project scope", () => {
  test("writes under <project>/.alpha + <project>/.opencode bridge + project receipt", () => {
    const projectDir = path.join(base, "proj")
    fs.mkdirSync(projectDir, { recursive: true })
    const r = writeSkill("proj-skill", "d", "b", { scope: "project", projectDir })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(projectDir, ".alpha", "skills", "proj-skill", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(projectDir, ".opencode", "skills"))).toBe(false) // T3:skills 桥退役
    // .alpha self-ignores (ADR-019 §5)
    expect(fs.readFileSync(path.join(projectDir, ".alpha", ".gitignore"), "utf8")).toBe("*\n")
    const { receipts } = readLedger(path.join(projectDir, ".alpha"))
    expect(receipts[0]).toMatchObject({ scope: "project", name: "proj-skill" })
    // global ledger untouched
    expect(readLedger(alphaDir).receipts).toHaveLength(0)
  })

  test("invalid project dir fails honestly", () => {
    const r = writeSkill("x", "d", "b", { scope: "project", projectDir: "/" })
    expect(r.ok).toBe(false)
  })
})

describe("installBuiltinSkill — name + asset-key guards", () => {
  test("rejects unsafe skill name before touching resources", () => {
    expect(installBuiltinSkill("skills/valid", "../evil")).toEqual({ ok: false, reason: "invalid skill name" })
  })

  test.each([["../secrets"], ["skills/../../x"], ["plugins/x"], ["skills/a/b"], ["notskills/x"]])(
    "rejects asset key outside resources/skills %p",
    (key) => {
      expect(installBuiltinSkill(key, "good")).toEqual({ ok: false, reason: "invalid asset key" })
    },
  )

  test("honest failure when the (well-formed) asset isn't bundled in this build", () => {
    const r = installBuiltinSkill("skills/definitely-not-bundled", "good")
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain("未随此版本打包")
  })

  test("bundled asset installs into .alpha + bridge + catalog receipt", () => {
    // safe-refactor ships in repo resources/skills (E1b)
    const r = installBuiltinSkill("skills/safe-refactor", "safe-refactor", { scope: "global" }, { catalogId: "skill:safe-refactor" })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "skills", "safe-refactor", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(opencodeDir, "skills"))).toBe(false) // T3:skills 桥退役
    const { receipts } = readLedger(alphaDir)
    expect(receipts).toHaveLength(0) // #354:catalog 的账本所有权归 planner,installer 层零 v1 写
  })
})

// REQ-128 `#706`:`removeFsInstall` **不再碰账本**。它原先在删完实物之后调 v1 `removeReceipt`
// 且忽略返回值 —— 那条路会把账本重写成 v:2(V3 的 packageGraphs/claims 静默蒸发),而且失败
// 不可见。去账现在只归外层单点提交,claim-aware 判决在删实物之前就做完。
describe("removeFsInstall — deletes truth and unbridges; the ledger is NOT its business (T6 / #706)", () => {
  test("uninstalling a skill removes truth dir and .opencode item, and leaves the ledger untouched", () => {
    writeSkill("gone-skill", "d", "b")
    addReceipt(alphaDir, {
      id: "skill:gone-skill",
      name: "gone-skill",
      type: "skill",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "catalog",
    })
    const before = fs.readFileSync(path.join(alphaDir, "installs.json"), "utf8")
    expect(fs.existsSync(path.join(alphaDir, "skills", "gone-skill", "SKILL.md"))).toBe(true)
    const r = removeFsInstall("skill", "gone-skill")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "skills", "gone-skill"))).toBe(false)
    expect(fs.existsSync(path.join(opencodeDir, "skills", "gone-skill"))).toBe(false)
    // 账本字节零改动 —— 把内层副作用接回来会让这一行立刻变红。
    expect(fs.readFileSync(path.join(alphaDir, "installs.json"), "utf8")).toBe(before)
    expect(readLedger(alphaDir).receipts.some((x) => x.name === "gone-skill")).toBe(true)
  })

  test("uninstalling an agent removes the md and leaves the ledger untouched", () => {
    writeAgent("gone-agent", "---\ndescription: d\n---\nsys")
    addReceipt(alphaDir, {
      id: "agent:gone-agent",
      name: "gone-agent",
      type: "agent",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "catalog",
    })
    const before = fs.readFileSync(path.join(alphaDir, "installs.json"), "utf8")
    const r = removeFsInstall("agent", "gone-agent")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "agents", "gone-agent.md"))).toBe(false)
    expect(fs.readFileSync(path.join(alphaDir, "installs.json"), "utf8")).toBe(before)
    expect(readLedger(alphaDir).receipts.some((x) => x.name === "gone-agent")).toBe(true)
  })

  test("uninstalling a missing item is idempotent success", () => {
    expect(removeFsInstall("skill", "never-installed").ok).toBe(true)
  })

  test("rejects unsafe name", () => {
    expect(removeFsInstall("skill", "../evil").ok).toBe(false)
  })
})

describe("collectBuiltinAgentPayload — #361 随包 agent 载荷收集(只读;CAS 摄取源)", () => {
  test("非法/越界 asset key 与非法名拒收(零盘读)", () => {
    expect(collectBuiltinAgentPayload("../evil.md", "x").ok).toBe(false)
    expect(collectBuiltinAgentPayload("agents/../../evil.md", "x").ok).toBe(false)
    expect(collectBuiltinAgentPayload("skills/demo", "x").ok).toBe(false) // 非 agents/<name>.md 形状
    expect(collectBuiltinAgentPayload("agents/code-reviewer.md", "../evil").ok).toBe(false)
  })

  test("缺包如实失败(不造 placeholder)", () => {
    const r = collectBuiltinAgentPayload("agents/definitely-not-bundled.md", "definitely-not-bundled")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("未随此版本打包")
  })

  test("key 与 name 交叉不一致拒收(内容身份合同,#384 r1 Major 1:配错的已验签条目不得借身份装别的资产)", () => {
    const r = collectBuiltinAgentPayload("agents/code-reviewer.md", "other-name")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("content identity drift")
  })

  test("真实随包资产:返回原始 Buffer(byte-exact)+ 顶层 .md 路径,零副作用", () => {
    const r = collectBuiltinAgentPayload("agents/code-reviewer.md", "code-reviewer")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files).toHaveLength(1)
    expect(r.files[0]!.path).toBe("code-reviewer.md")
    const bundled = fs.readFileSync(path.join(resourcesRoot(), "agents", "code-reviewer.md"))
    expect(r.files[0]!.data.equals(bundled)).toBe(true)
    expect(fs.readdirSync(alphaDir)).toEqual([]) // 收集不落任何安装副作用
  })
})

describe("ALPHA_LEGACY_INSTALL_ROOT=1 escape hatch", () => {
  test("writes the old XDG root, no bridge, no receipt", () => {
    const legacyRoot = path.join(base, "xdg-opencode")
    process.env.OPENCODE_CONFIG_DIR = legacyRoot
    process.env.ALPHA_LEGACY_INSTALL_ROOT = "1"
    try {
      const r = writeSkill("legacy-skill", "d", "b")
      expect(r.ok).toBe(true)
      expect(fs.existsSync(path.join(legacyRoot, "skills", "legacy-skill", "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(alphaDir, "skills"))).toBe(false)
      expect(readLedger(alphaDir).receipts).toHaveLength(0)
    } finally {
      delete process.env.ALPHA_LEGACY_INSTALL_ROOT
      delete process.env.OPENCODE_CONFIG_DIR
    }
  })
})

// ── REQ-099 #306:未策展 fs 安装的落账所有权 → coordinator(v2 record + 派生 v1 receipt)──────

describe("uncurated fs installs land v2 records (#306)", () => {
  test("writeAgent(imported,无 meta)→ v2 record:id user:<name>、origin imported、无供给链字段", async () => {
    const { findRecordV2 } = await import("./ext-receipt-v2")
    const r = writeAgent("imp-agent", "---\ndescription: d\nmode: subagent\n---\nsys", undefined, undefined, "imported")
    expect(r.ok).toBe(true)
    const rec = findRecordV2(alphaDir, "agent", "imp-agent")
    expect(rec?.id).toBe("user:imp-agent")
    expect(rec?.origin).toBe("imported")
    expect(rec?.manifestDigest).toBeUndefined()
    // 派生 v1 receipt 同键在账(降级可读)
    expect(readLedger(alphaDir).receipts.some((x) => x.name === "imp-agent" && x.type === "agent")).toBe(true)
  })

  test("writeAgent 落账被 catalog 同键拒绝 → fail-closed 补偿(md 与 config 条目都不留)", async () => {
    const { upsertRecordV2 } = await import("./ext-receipt-v2")
    // 预置同键 catalog record(模拟 catalog agent 在账)
    expect(
      upsertRecordV2(alphaDir, {
        id: "agent:pm",
        name: "pm",
        kind: "agent",
        environment: "prod",
        scope: { kind: "global" },
        desiredState: "enabled",
        origin: "catalog",
        installedAt: new Date().toISOString(),
      }).ok,
    ).toBe(true)
    const r = writeAgent("pm", "---\ndescription: d\nmode: subagent\n---\nsys", undefined, undefined, "imported")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("catalog install")
    expect(fs.existsSync(path.join(alphaDir, "agents", "pm.md"))).toBe(false) // 补偿:md 已撤
  })
})

// ── #354(review #379 Blocker):agent 在场检查必须覆盖手工 `agent.<name>` 配置项 ──────────────────
describe("agentInstallPresent (REQ-100 #354)", () => {
  test("md 在场 / 手工配置项在场 / 语法损坏配置 → 一律 true;全净 → false", () => {
    expect(agentInstallPresent("helper", { scope: "global" })).toBe(false)
    // 手工 agent.<name> 配置(无 md、无账)= 既有安装事实,覆盖它会造成用户数据丢失。
    fs.mkdirSync(alphaDir, { recursive: true })
    fs.writeFileSync(path.join(alphaDir, "alpha.jsonc"), JSON.stringify({ agent: { helper: { prompt: "hand written" } } }))
    expect(agentInstallPresent("helper", { scope: "global" })).toBe(true)
    // 语法损坏 → fail-closed 在场。
    fs.writeFileSync(path.join(alphaDir, "alpha.jsonc"), '{ "agent": { broken')
    expect(agentInstallPresent("helper", { scope: "global" })).toBe(true)
    // md 在场(无配置项)。
    fs.writeFileSync(path.join(alphaDir, "alpha.jsonc"), "{}")
    fs.mkdirSync(path.join(alphaDir, "agents"), { recursive: true })
    fs.writeFileSync(path.join(alphaDir, "agents", "helper.md"), "---\ndescription: d\n---\nbody")
    expect(agentInstallPresent("helper", { scope: "global" })).toBe(true)
  })
})

describe("collectVendoredPluginPayload — ADR-040 后无随包 plugin 资产", () => {
  test("the retired bundled asset is absent and cannot be collected", () => {
    const retired = collectVendoredPluginPayload("plugins/opencode-notify", "opencode-notify")
    expect(retired.ok).toBe(false)
    if (!retired.ok) expect(retired.reason).toContain("未随此版本打包")
  })

  test("missing asset and unsafe key/name are refused", () => {
    const ghost = collectVendoredPluginPayload("plugins/ghost-plugin", "ghost-plugin")
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toContain("未随此版本打包")
    expect(collectVendoredPluginPayload("../evil", "x").ok).toBe(false)
    expect(collectVendoredPluginPayload("plugins/opencode-notify", "../x").ok).toBe(false)
  })

  test("#378 r5:内容身份交叉 —— key ≠ plugins/<name> 拒(配错的 entry 不得按本名装入别的资产)", () => {
    const drift = collectVendoredPluginPayload("plugins/opencode-notify", "other-name")
    expect(drift.ok).toBe(false)
    if (!drift.ok) expect(drift.reason).toContain("content identity drift")
  })

  test("staging cannot revive an absent packaged plugin", () => {
    const retired = stageVendoredPluginVersioned("plugins/opencode-notify", "opencode-notify")
    expect(retired.ok).toBe(false)
    if (!retired.ok) expect(retired.reason).toContain("未随此版本打包")
    const ghost = stageVendoredPluginVersioned("plugins/ghost-plugin", "ghost-plugin")
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toContain("未随此版本打包")
  })
})
