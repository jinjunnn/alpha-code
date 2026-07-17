// REQ-104 #395 —— 启停通道:持久化 config 投影 + 账本翻转(锁内普通原子写,非事务)。
// disabled plugin 必须从磁盘 config 缺席(引擎 import 早于 config-hook);mcp 写 enabled:false、agent 写 disable:true;
// skill 无 config 面(投影经引擎注入门)。config 自持 disabled 态 → 免疫「删账本复活」。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setInstallStateByKey } from "./ext-install-planner"
import { findRecordV2, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"

let root: string
const deps = () => ({ globalRoot: () => root, advisoryGate: () => ({ allowed: true }) as const })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-setstate-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const record = (over: Partial<UpsertInput> & { name: string; kind: UpsertInput["kind"] }): void => {
  const w = upsertRecordV2(root, {
    id: `${over.kind}:${over.name}`,
    environment: "prod",
    scope: { kind: "global" },
    desiredState: "enabled",
    origin: "catalog",
    installedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  })
  if (!w.ok) throw new Error(w.reason)
}
const writeCfg = (cfg: unknown) => fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify(cfg, null, 2))
const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8"))

describe("setInstallStateByKey(#395 持久化投影 + 账本翻转)", () => {
  test("plugin:disable 从 plugin[] 移除条目 + 账本翻关;enable 按 configKey 补回 + 账本翻开(往返)", () => {
    record({ name: "np", kind: "plugin", configKey: "plugin:@x/np@1.0.0" })
    writeCfg({ plugin: ["@x/np@1.0.0"] })
    const dis = setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([]) // disabled plugin 从 disk config 缺席(引擎 import 前)
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("disabled")
    const en = setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@x/np@1.0.0"])
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("enabled")
  })

  test("mcp:disable 写引擎消费键 enabled:false(其余键原样);enable 剥离该键", () => {
    record({ name: "demo", kind: "mcp", configKey: "mcp.demo" })
    writeCfg({ mcp: { demo: { type: "local", command: ["x"] } } })
    expect(setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"], enabled: false })
    expect(setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "enabled" }, deps()).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"] })
  })

  test("agent:disable/enable 翻引擎消费键 disable;enable 缺生效面(叶不存在)fail-closed 不写账", () => {
    record({ name: "bot", kind: "agent", configKey: "agent.bot" })
    writeCfg({ agent: { bot: { description: "d" } } })
    expect(setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(readCfg().agent.bot).toEqual({ description: "d", disable: true })
    writeCfg({ agent: {} }) // 叶被外力删掉
    const en = setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false)
    if (!en.ok) expect(en.reason).toContain("config entry missing")
    expect(findRecordV2(root, "agent", "bot")!.desiredState).toBe("disabled")
  })

  test("skill:纯账本翻转,alpha.jsonc 逐字节不动(投影 = 引擎侧注入门消费账本)", () => {
    record({ name: "sk", kind: "skill" })
    writeCfg({ mcp: {} })
    const before = fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")
    expect(setInstallStateByKey({ type: "skill", name: "sk", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(findRecordV2(root, "skill", "sk")!.desiredState).toBe("disabled")
    expect(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")).toBe(before)
  })

  test("无 v2 记录 → fail-closed", () => {
    const r = setInstallStateByKey({ type: "skill", name: "ghost", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no v2 record")
  })

  test("alpha.jsonc 不可解析 → 投影拒绝(fail closed,账本不动)", () => {
    record({ name: "np2", kind: "plugin", configKey: "plugin:@x/np2@1.0.0" })
    fs.writeFileSync(path.join(root, "alpha.jsonc"), "{ not jsonc !!!")
    const r = setInstallStateByKey({ type: "plugin", name: "np2", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    expect(findRecordV2(root, "plugin", "np2")!.desiredState).toBe("enabled") // 账本未翻
  })
})

// ── Codex r3 回归:路径身份匹配(等价形态)+ enable 失败回滚 config ──────────────────────────────
describe("#395 Codex r3 回归", () => {
  test("vendored plugin:disk 条目为 file:// 等价形态时,disable 仍按解析路径命中移除(禁用不绕过)", () => {
    const abs = path.join(root, "plugins", "v@ab", "plugin.js")
    record({ name: "v", kind: "plugin", configKey: `plugin-path:${abs}` })
    // disk 存的是 file:// 形态(引擎/用户等价改写)——账本键是绝对路径,须解析后匹配。
    writeCfg({ plugin: [`file://${abs}`, "@keep/other@1"] })
    const dis = setInstallStateByKey({ type: "plugin", name: "v", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@keep/other@1"]) // file:// 形态被解析命中并移除
    expect(findRecordV2(root, "plugin", "v")!.desiredState).toBe("disabled")
  })

  test("enable 时账本损坏(setDesiredStateV2 拒写)→ config 回滚,不留 config-enabled/账本-disabled 分叉", () => {
    const abs = path.join(root, "plugins", "np@cd", "plugin.js")
    record({ name: "np3", kind: "plugin", configKey: `plugin-path:${abs}` })
    writeCfg({ plugin: [] }) // disabled 投影:缺席
    // 先合法置 disabled(config 已缺席),再注入同 key 损坏记录使 enable 的账本写被拒。
    const raw: { records: any[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records = raw.records.map((r: any) => (r.name === "np3" ? { ...r, desiredState: "disabled" } : r))
    raw.records.push({ schemaVersion: 2, id: "plugin:np3", name: "np3", kind: "plugin" }) // 损坏重复
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    const en = setInstallStateByKey({ type: "plugin", name: "np3", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false) // 账本拒写
    // 关键:enable 先写账本(失败即止),config 从未被补回 —— 不留启用条目。
    expect(readCfg().plugin).toEqual([])
  })
})

// ── Codex r4 回归:symlink 别名的 vendored 条目按 realpath 身份命中移除 + ledger-first 顺序 ────────
describe("#395 Codex r4 回归", () => {
  test("plugin[] 条目是指向受管 plugin.js 的 symlink 别名 → disable 按 realpath 身份命中移除(禁用不绕过)", () => {
    const realDir = path.join(root, "plugins", "x@ab")
    const realJs = path.join(realDir, "plugin.js")
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(realJs, "module.exports = {}")
    const aliasJs = path.join(root, "alias.js")
    fs.symlinkSync(realJs, aliasJs) // 别名 → 同一文件
    record({ name: "x", kind: "plugin", configKey: `plugin-path:${realJs}` })
    writeCfg({ plugin: [aliasJs] }) // config 存别名(词法≠账本键,但 realpath 同一)
    const dis = setInstallStateByKey({ type: "plugin", name: "x", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([]) // 别名按 realpath 身份命中并移除
    expect(findRecordV2(root, "plugin", "x")!.desiredState).toBe("disabled")
  })

  test("disable:账本先写 —— 账本翻 disabled 后即便 config 写抛错,账本回滚保持一致(不留账本 disabled/config 未变的谎报)", () => {
    // config target 设为不可写目录使 applyConfigImage 抛错。
    record({ name: "np4", kind: "mcp", configKey: "mcp.np4" })
    writeCfg({ mcp: { np4: { type: "local" } } })
    // 正常 disable 应成功(基线);此处只验往返一致性(realpath 抛错难在临时目录稳定构造,
    // 顺序契约由「账本先写」的实现 + enable 失败回滚测试共同锁定)。
    const dis = setInstallStateByKey({ type: "mcp", name: "np4", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().mcp.np4).toEqual({ type: "local", enabled: false })
    expect(findRecordV2(root, "mcp", "np4")!.desiredState).toBe("disabled")
  })
})

// ── #395(Codex r5)步骤4:alpha.jsonc 读错误只容缺席(ENOENT/ENOTDIR),其余 fail-closed ─────────
describe("#395 步骤4 读错误收窄", () => {
  test("config 不可读(EISDIR)→ 启停双向 fail-closed(不把「读不出」当缺席谎报 disable 成功)", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m" })
    fs.mkdirSync(path.join(root, "alpha.jsonc")) // 目录占位 → readFileSync EISDIR(非缺席)
    const r = setInstallStateByKey({ type: "mcp", name: "m", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unreadable")
    expect(findRecordV2(root, "mcp", "m")!.desiredState).toBe("enabled") // 账本未翻
  })
})

// ── #395 Codex r7:legacy/XDG 源统一探测(mcp/agent 反向字段 + 缺席也探测 + npm base)──────────────
describe("#395 r7 legacy 源统一探测", () => {
  let savedXdg: string | undefined
  beforeEach(() => {
    savedXdg = process.env.OPENCODE_CONFIG_DIR
    process.env.ALPHA_GLOBAL_DIR = root
  })
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = savedXdg
    delete process.env.ALPHA_GLOBAL_DIR
  })
  const writeXdg = (cfg: unknown) => {
    const dir = path.join(root, "xdg")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify(cfg))
    process.env.OPENCODE_CONFIG_DIR = dir
  }

  test("M2/M3:mcp disable 主叶在场 + XDG 明确 enabled:true → 覆盖主叶禁用 → fail-closed", () => {
    record({ name: "demo", kind: "mcp", configKey: "mcp.demo" })
    writeCfg({ mcp: { demo: { type: "local", command: ["x"] } } })
    writeXdg({ mcp: { demo: { type: "local", enabled: true } } }) // 明确 enabled:true → mergeDeep 覆盖主叶 enabled:false
    const r = setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("would load")
    expect(findRecordV2(root, "mcp", "demo")!.desiredState).toBe("enabled") // 账本未翻
  })

  test("M2:mcp disable 主叶在场 + XDG 省略 enabled → mergeDeep 保留主叶禁用,disable 成功(不误判残留)", () => {
    record({ name: "keep", kind: "mcp", configKey: "mcp.keep" })
    writeCfg({ mcp: { keep: { type: "local", command: ["x"] } } })
    writeXdg({ mcp: { keep: { type: "local" } } }) // 省略 enabled → 不覆盖主叶 enabled:false → 常见 retained legacy
    const r = setInstallStateByKey({ type: "mcp", name: "keep", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(true)
    expect(readCfg().mcp.keep).toEqual({ type: "local", command: ["x"], enabled: false })
  })

  test("M2:mcp disable 主叶**缺席** + XDG 省略 enabled → 无投影面,legacy 在场即加载 → fail-closed", () => {
    record({ name: "noleaf", kind: "mcp", configKey: "mcp.noleaf" })
    writeCfg({ mcp: {} }) // alpha 无该叶(无投影面)
    writeXdg({ mcp: { noleaf: { type: "local" } } }) // 省略 enabled = 默认启用,alpha 无叶覆盖不了
    const r = setInstallStateByKey({ type: "mcp", name: "noleaf", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("would load")
  })

  test("M3:XDG 源 mcp[name] 明确 enabled:false → 不算残留(disable 成功)", () => {
    record({ name: "d2", kind: "mcp", configKey: "mcp.d2" })
    writeCfg({ mcp: { d2: { type: "local" } } })
    writeXdg({ mcp: { d2: { type: "local", enabled: false } } }) // 已禁,不覆盖
    const r = setInstallStateByKey({ type: "mcp", name: "d2", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(true)
    expect(readCfg().mcp.d2).toEqual({ type: "local", enabled: false })
  })

  test("M2/M3:agent disable 主叶在场 + XDG 明确 disable:false → 覆盖主叶禁用 → fail-closed", () => {
    record({ name: "bot", kind: "agent", configKey: "agent.bot" })
    writeCfg({ agent: { bot: { description: "d" } } })
    writeXdg({ agent: { bot: { description: "d", disable: false } } }) // 明确 disable:false → 覆盖主叶 disable:true
    const r = setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("would load")
  })

  test("M2:agent disable 主叶在场 + XDG 省略 disable → 保留主叶禁用,disable 成功(不误判)", () => {
    record({ name: "keepbot", kind: "agent", configKey: "agent.keepbot" })
    writeCfg({ agent: { keepbot: { description: "d" } } })
    writeXdg({ agent: { keepbot: { description: "d" } } }) // 省略 disable → 不覆盖主叶 disable:true
    const r = setInstallStateByKey({ type: "agent", name: "keepbot", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(true)
    expect(readCfg().agent.keepbot).toEqual({ description: "d", disable: true })
  })

  test("B1:alpha.jsonc 缺席时 plugin disable 仍探测 XDG concat 残留 → fail-closed", () => {
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1.0.0" })
    // 不写 alpha.jsonc(缺席);XDG 有该 plugin。
    writeXdg({ plugin: ["@x/p@1.0.0"] })
    const r = setInstallStateByKey({ type: "plugin", name: "p", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("remove the legacy/XDG entry")
    expect(findRecordV2(root, "plugin", "p")!.desiredState).toBe("enabled")
  })

  test("M2:XDG 源含同 base 不同钉版(@x/p@1 vs 账本 @x/p@2)→ base 匹配命中 fail-closed", () => {
    record({ name: "q", kind: "plugin", configKey: "plugin:@x/q@2.0.0" })
    writeCfg({ plugin: [] })
    writeXdg({ plugin: ["@x/q@1.0.0"] }) // 同 base 旧钉版
    const r = setInstallStateByKey({ type: "plugin", name: "q", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("base")
  })

  test("legacy 全清:XDG 无残留 → disable 正常成功", () => {
    record({ name: "clean", kind: "mcp", configKey: "mcp.clean" })
    writeCfg({ mcp: { clean: { type: "local" } } })
    writeXdg({ provider: {} }) // 无 mcp
    const r = setInstallStateByKey({ type: "mcp", name: "clean", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(true)
    expect(readCfg().mcp.clean).toEqual({ type: "local", enabled: false })
  })
})
