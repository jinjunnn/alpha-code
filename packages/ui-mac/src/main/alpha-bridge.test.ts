// Unit tests for the .alpha ↔ .opencode symlink bridge (REQ-018 T2). Real temp dirs, real
// symlinks — the exact shapes the REQ-004 spike validated against the engine's glob behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { bridgeItem, unbridgeItem } from "./alpha-bridge"

let alphaDir: string
let opencodeDir: string
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-bridge-"))
  alphaDir = path.join(base, ".alpha")
  opencodeDir = path.join(base, ".opencode")
  fs.mkdirSync(alphaDir, { recursive: true })
})
afterEach(() => {
  fs.rmSync(path.dirname(alphaDir), { recursive: true, force: true })
})

function seedSkill(name: string) {
  const dir = path.join(alphaDir, "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8")
}

describe("bridgeItem — fresh state prefers one dir-link", () => {
  test("creates <opencodeDir>/skills → <alphaDir>/skills and the skill is reachable through it", () => {
    seedSkill("demo")
    const r = bridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(r.ok).toBe(true)
    expect(r.ok && r.mode).toBe("dir-link")
    const link = path.join(opencodeDir, "skills")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, "demo", "SKILL.md"), "utf8")).toContain("demo")
  })

  test("second install over an existing dir-link is covered (no new links)", () => {
    seedSkill("one")
    expect(bridgeItem(alphaDir, opencodeDir, "skills", "one").ok).toBe(true)
    seedSkill("two")
    const r = bridgeItem(alphaDir, opencodeDir, "skills", "two")
    expect(r.ok && r.mode).toBe("covered")
    expect(fs.readFileSync(path.join(opencodeDir, "skills", "two", "SKILL.md"), "utf8")).toContain("two")
  })
})

describe("bridgeItem — existing real dir degrades to per-item links", () => {
  test("user's own skills dir is preserved; our skill arrives as an item link", () => {
    fs.mkdirSync(path.join(opencodeDir, "skills", "users-own"), { recursive: true })
    seedSkill("demo")
    const r = bridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(r.ok && r.mode).toBe("item-link")
    expect(fs.existsSync(path.join(opencodeDir, "skills", "users-own"))).toBe(true)
    const itemLink = path.join(opencodeDir, "skills", "demo")
    expect(fs.lstatSync(itemLink).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(itemLink, "SKILL.md"), "utf8")).toContain("demo")
  })

  test("agents bridge links single files (<name>.md)", () => {
    fs.mkdirSync(path.join(opencodeDir, "agents"), { recursive: true })
    fs.mkdirSync(path.join(alphaDir, "agents"), { recursive: true })
    fs.writeFileSync(path.join(alphaDir, "agents", "helper.md"), "---\ndescription: h\n---\n", "utf8")
    const r = bridgeItem(alphaDir, opencodeDir, "agents", "helper")
    expect(r.ok && r.mode).toBe("item-link")
    expect(fs.readFileSync(path.join(opencodeDir, "agents", "helper.md"), "utf8")).toContain("description")
  })

  test("refuses to clobber a real same-name entry (honest conflict)", () => {
    fs.mkdirSync(path.join(opencodeDir, "skills", "demo"), { recursive: true })
    seedSkill("demo")
    const r = bridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("已存在同名条目")
  })

  test("a non-directory in the bridge position fails honestly", () => {
    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(path.join(opencodeDir, "skills"), "not a dir", "utf8")
    seedSkill("demo")
    const r = bridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("not a directory")
  })

  test("rejects hostile names before touching disk", () => {
    expect(bridgeItem(alphaDir, opencodeDir, "skills", "../evil").ok).toBe(false)
  })
})

describe("unbridgeItem — removes only our own item links", () => {
  test("removes an alpha item link, leaves user entries and shared dir-links alone", () => {
    fs.mkdirSync(path.join(opencodeDir, "skills", "users-own"), { recursive: true })
    seedSkill("demo")
    bridgeItem(alphaDir, opencodeDir, "skills", "demo")
    const gone = unbridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(gone.removed).toHaveLength(1)
    expect(fs.existsSync(path.join(opencodeDir, "skills", "demo"))).toBe(false)
    expect(fs.existsSync(path.join(opencodeDir, "skills", "users-own"))).toBe(true)
  })

  test("does not remove a shared dir-link (bridge infrastructure)", () => {
    seedSkill("demo")
    bridgeItem(alphaDir, opencodeDir, "skills", "demo") // dir-link mode
    const gone = unbridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(gone.removed).toHaveLength(0)
    expect(fs.lstatSync(path.join(opencodeDir, "skills")).isSymbolicLink()).toBe(true)
  })

  test("does not remove a foreign symlink with the same name", () => {
    const foreign = path.join(path.dirname(alphaDir), "elsewhere")
    fs.mkdirSync(foreign, { recursive: true })
    fs.mkdirSync(path.join(opencodeDir, "skills"), { recursive: true })
    fs.symlinkSync(foreign, path.join(opencodeDir, "skills", "demo"), "dir")
    seedSkill("demo")
    const gone = unbridgeItem(alphaDir, opencodeDir, "skills", "demo")
    expect(gone.removed).toHaveLength(0)
    expect(fs.lstatSync(path.join(opencodeDir, "skills", "demo")).isSymbolicLink()).toBe(true)
  })
})
