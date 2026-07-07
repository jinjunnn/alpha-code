// Unit tests for the skill/agent installer (REQ-018 T2 rework). Rejection paths (name/asset-key
// guards) return before disk I/O. Accept paths are now fully testable off-device: the alpha truth
// root and engine bridge root honor ALPHA_GLOBAL_DIR / ALPHA_OPENCODE_HOME env overrides, so real
// writes land in throwaway temp dirs — we assert truth files, bridge symlinks AND receipts.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

mock.module("electron", () => ({ app: { isPackaged: false } }))

const { installBuiltinSkill, installRemoteAgent, removeFsInstall, writeAgent, writeSkill } = await import("./ext-fs-installer")
const { readLedger } = await import("./alpha-installs")

let base = ""
let alphaDir = ""
let opencodeDir = ""
const prevAlpha = process.env.ALPHA_GLOBAL_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-installer-"))
  alphaDir = path.join(base, ".alpha")
  opencodeDir = path.join(base, ".opencode")
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
      expect(fs.existsSync(alphaDir)).toBe(false)
    },
  )

  test.each([["../../etc/passwd"], ["a/b"], [""]])("writeAgent rejects unsafe name %p", (name) => {
    expect(writeAgent(name, "content")).toEqual({ ok: false, reason: "invalid agent name" })
  })
})

describe("writeSkill — global scope writes truth + bridge + receipt", () => {
  test("SKILL.md lands in ~/.alpha/skills (T3: engine sees it via skills.paths, no .opencode bridge)", () => {
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

  test("catalog meta flows into the receipt (id/version/origin)", () => {
    const r = writeSkill("cat-skill", "d", "b", { scope: "global" }, { catalogId: "skill:cat-skill", version: "2026-07-03.1" })
    expect(r.ok).toBe(true)
    const { receipts } = readLedger(alphaDir)
    expect(receipts[0]).toMatchObject({ id: "skill:cat-skill", version: "2026-07-03.1", origin: "catalog" })
  })
})

describe("writeAgent — global scope", () => {
  test("agent md lands in ~/.alpha/agents and bridges as agents/<name>.md", () => {
    const r = writeAgent("helper", "---\ndescription: h\n---\nsystem")
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(alphaDir, "agents", "helper.md"), "utf8")).toContain("system")
    expect(fs.readFileSync(path.join(opencodeDir, "agents", "helper.md"), "utf8")).toContain("system")
    const { receipts } = readLedger(alphaDir)
    expect(receipts[0]).toMatchObject({ type: "agent", name: "helper" })
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
    expect(receipts[0]).toMatchObject({ id: "skill:safe-refactor", origin: "catalog", type: "skill" })
  })
})

describe("removeFsInstall — deletes truth, unbridges, drops receipt (T6)", () => {
  test("uninstalling a skill removes truth dir, .opencode item, and receipt", () => {
    writeSkill("gone-skill", "d", "b")
    expect(fs.existsSync(path.join(alphaDir, "skills", "gone-skill", "SKILL.md"))).toBe(true)
    const r = removeFsInstall("skill", "gone-skill")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "skills", "gone-skill"))).toBe(false)
    expect(fs.existsSync(path.join(opencodeDir, "skills", "gone-skill"))).toBe(false)
    expect(readLedger(alphaDir).receipts.some((x) => x.name === "gone-skill")).toBe(false)
  })

  test("uninstalling an agent removes the md and receipt", () => {
    writeAgent("gone-agent", "---\ndescription: d\n---\nsys")
    const r = removeFsInstall("agent", "gone-agent")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(alphaDir, "agents", "gone-agent.md"))).toBe(false)
    expect(readLedger(alphaDir).receipts.some((x) => x.name === "gone-agent")).toBe(false)
  })

  test("uninstalling a missing item is idempotent success", () => {
    expect(removeFsInstall("skill", "never-installed").ok).toBe(true)
  })

  test("rejects unsafe name", () => {
    expect(removeFsInstall("skill", "../evil").ok).toBe(false)
  })
})

describe("installRemoteAgent — REQ-046 远程 agent 通道(单 .md 约定 + writeAgent 同管线)", () => {
  const md = (s = "---\ndescription: remote helper\n---\nsystem prompt") => Buffer.from(s, "utf8")

  test("happy path:单 .md → 真源 + 桥 + 账本(origin=catalog,meta 记版本)", () => {
    const r = installRemoteAgent("remote-helper", [{ path: "remote-helper.md", data: md() }], undefined, {
      catalogId: "agent:remote-helper",
      version: "1.0.0",
    })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(alphaDir, "agents", "remote-helper.md"), "utf8")).toContain("system prompt")
    expect(fs.readFileSync(path.join(opencodeDir, "agents", "remote-helper.md"), "utf8")).toContain("system prompt")
    const { receipts } = readLedger(alphaDir)
    expect(receipts[0]).toMatchObject({ type: "agent", name: "remote-helper", origin: "catalog" })
  })

  test("非法名拒装(无盘写)", () => {
    expect(installRemoteAgent("../evil", [{ path: "a.md", data: md() }]).ok).toBe(false)
    expect(fs.existsSync(alphaDir)).toBe(false)
  })

  test("多文件资产拒装(约定=恰好一个 .md)", () => {
    const r = installRemoteAgent("x", [
      { path: "x.md", data: md() },
      { path: "extra.txt", data: Buffer.from("junk") },
    ])
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain("exactly one")
  })

  test("非顶层/非 .md 路径拒装", () => {
    expect(installRemoteAgent("x", [{ path: "nested/x.md", data: md() }]).ok).toBe(false)
    expect(installRemoteAgent("x", [{ path: "x.txt", data: md() }]).ok).toBe(false)
  })

  test("超 256KB 拒装", () => {
    const big = Buffer.alloc(256 * 1024 + 1, 0x61)
    const r = installRemoteAgent("x", [{ path: "x.md", data: big }])
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain("过大")
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
