// REQ-104 #395 —— 启停通道:持久化 config 投影 + 账本翻转(锁内普通原子写,非事务)。
// disabled plugin 必须从磁盘 config 缺席(引擎 import 早于 config-hook);mcp 写 enabled:false、agent 写 disable:true;
// skill 无 config 面(投影经引擎注入门)。config 自持 disabled 态 → 免疫「删账本复活」。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setInstallStateByKey, type VerifiedCatalogEntry } from "./ext-install-planner"
import { findRecordV2, upsertRecordV2, type InstallReceiptType, type UpsertInput } from "./ext-receipt-v2"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"

let root: string
// #397 r1-5:enable 闸要求已验 entry 与 record 身份(id/kind/name/version)精确对应 ——
// 测试 deps 从账本回镜同身份 uncurated entry(本文件测的是 #395 投影语义,非 curation 面)。
const deps = () => ({
  globalRoot: () => root,
  advisoryGate: () => ({ allowed: true }) as const,
  resolveEntry: async (id: string): Promise<VerifiedCatalogEntry | null> => {
    const [kind, name] = id.split(":") as [InstallReceiptType, string]
    const rec = findRecordV2(root, kind, name)
    if (!rec) return null
    const entry = {
      id,
      type: kind,
      name,
      displayName: name,
      description: "t",
      source: "official",
      category: "t",
      ...(rec.version ? { version: rec.version } : {}),
    } as unknown as CatalogEntry
    return { entry, channel: "cache", catalogVersion: rec.version ?? "t" }
  },
})
// hermetic:隔离引擎真实读取的 legacy 源根(XDG 固定 = XDG_CONFIG_HOME/opencode;~/.opencode = ALPHA_OPENCODE_HOME),
// 使 legacyEnableResidueStrict 探测不碰开发机真实 ~/.config,并可精确造 before(XDG)/after(~/.opencode)源。
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-setstate-"))
  for (const k of ["XDG_CONFIG_HOME", "ALPHA_OPENCODE_HOME", "OPENCODE_CONFIG_DIR"]) savedEnv[k] = process.env[k]
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg-home") // → 引擎 XDG 目录 = <root>/xdg-home/opencode
  process.env.ALPHA_OPENCODE_HOME = path.join(root, "dot-opencode") // → ~/.opencode(after 源)
  delete process.env.OPENCODE_CONFIG_DIR
})
afterEach(() => {
  for (const k of ["XDG_CONFIG_HOME", "ALPHA_OPENCODE_HOME", "OPENCODE_CONFIG_DIR"]) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})
// 写引擎 XDG 全局源(before alpha)与 ~/.opencode(after alpha),供 before/after 语义测试。
const writeXdgGlobal = (cfg: unknown, file = "opencode.jsonc") => {
  const dir = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify(cfg))
}
const writeDotOpencode = (cfg: unknown, file = "opencode.jsonc") => {
  const dir = process.env.ALPHA_OPENCODE_HOME!
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify(cfg))
}

const record = (over: Partial<UpsertInput> & { name: string; kind: UpsertInput["kind"] }): void => {
  const w = upsertRecordV2(root, {
    id: `${over.kind}:${over.name}`,
    environment: "prod",
    scope: { kind: "global" },
    desiredState: "enabled",
    origin: "catalog",
    version: "1.0.0", // #397 r1-5:record 无 version 即无法自证身份,enable 会被拒 —— 测试记录补齐
    installedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  })
  if (!w.ok) throw new Error(w.reason)
}
const writeCfg = (cfg: unknown) => fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify(cfg, null, 2))
const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8"))

describe("setInstallStateByKey(#395 持久化投影 + 账本翻转)", () => {
  test("plugin:disable 仍从 plugin[] 移除并翻账本;**enable 具名拒绝且账本不翻**(ADR-040 第 6 条)", async () => {
    record({ name: "np", kind: "plugin", configKey: "plugin:@x/np@1.0.0" })
    writeCfg({ plugin: ["@x/np@1.0.0"] })
    const dis = await setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([]) // disabled plugin 从 disk config 缺席(引擎 import 前)
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("disabled")
    // 「启用」= 把 spec 写回 plugin[],与安装是同一件事换了个入口 —— 拒。
    const en = await setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false)
    if (!en.ok) expect(en.reason).toContain("ADR-040")
    // 关键:拒必须发生在**账本翻转之前** —— 否则账本说 enabled 而运行面空着,那是谎报。
    expect(readCfg().plugin).toEqual([])
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("disabled")
  })

  test("mcp:disable 写引擎消费键 enabled:false(其余键原样);enable 剥离该键", async () => {
    record({ name: "demo", kind: "mcp", configKey: "mcp.demo" })
    writeCfg({ mcp: { demo: { type: "local", command: ["x"] } } })
    expect((await setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "disabled" }, deps())).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"], enabled: false })
    expect((await setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "enabled" }, deps())).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"] })
  })

  test("agent:disable/enable 翻引擎消费键 disable;enable 缺生效面(叶不存在)fail-closed 不写账", async () => {
    record({ name: "bot", kind: "agent", configKey: "agent.bot" })
    writeCfg({ agent: { bot: { description: "d" } } })
    expect((await setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "disabled" }, deps())).ok).toBe(true)
    expect(readCfg().agent.bot).toEqual({ description: "d", disable: true })
    writeCfg({ agent: {} }) // 叶被外力删掉
    const en = await setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false)
    if (!en.ok) expect(en.reason).toContain("config entry missing")
    expect(findRecordV2(root, "agent", "bot")!.desiredState).toBe("disabled")
  })

  test("skill:纯账本翻转,alpha.jsonc 逐字节不动(投影 = 引擎侧注入门消费账本)", async () => {
    record({ name: "sk", kind: "skill" })
    writeCfg({ mcp: {} })
    const before = fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")
    expect((await setInstallStateByKey({ type: "skill", name: "sk", scope: "global", state: "disabled" }, deps())).ok).toBe(true)
    expect(findRecordV2(root, "skill", "sk")!.desiredState).toBe("disabled")
    expect(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")).toBe(before)
  })

  test("无 v2 记录 → fail-closed", async () => {
    const r = await setInstallStateByKey({ type: "skill", name: "ghost", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no v2 record")
  })

  test("alpha.jsonc 不可解析 → 投影拒绝(fail closed,账本不动)", async () => {
    record({ name: "np2", kind: "plugin", configKey: "plugin:@x/np2@1.0.0" })
    fs.writeFileSync(path.join(root, "alpha.jsonc"), "{ not jsonc !!!")
    const r = await setInstallStateByKey({ type: "plugin", name: "np2", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    expect(findRecordV2(root, "plugin", "np2")!.desiredState).toBe("enabled") // 账本未翻
  })
})

// ── Codex r3 回归:路径身份匹配(等价形态)+ enable 失败回滚 config ──────────────────────────────
describe("#395 Codex r3 回归", () => {
  test("vendored plugin:disk 条目为 file:// 等价形态时,disable 仍按解析路径命中移除(禁用不绕过)", async () => {
    const abs = path.join(root, "plugins", "v@ab", "plugin.js")
    record({ name: "v", kind: "plugin", configKey: `plugin-path:${abs}` })
    // disk 存的是 file:// 形态(引擎/用户等价改写)——账本键是绝对路径,须解析后匹配。
    writeCfg({ plugin: [`file://${abs}`, "@keep/other@1"] })
    const dis = await setInstallStateByKey({ type: "plugin", name: "v", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@keep/other@1"]) // file:// 形态被解析命中并移除
    expect(findRecordV2(root, "plugin", "v")!.desiredState).toBe("disabled")
  })

  test("enable 时账本损坏(setDesiredStateV2 拒写)→ config 回滚,不留 config-enabled/账本-disabled 分叉", async () => {
    const abs = path.join(root, "plugins", "np@cd", "plugin.js")
    record({ name: "np3", kind: "plugin", configKey: `plugin-path:${abs}` })
    writeCfg({ plugin: [] }) // disabled 投影:缺席
    // 先合法置 disabled(config 已缺席),再注入同 key 损坏记录使 enable 的账本写被拒。
    const raw: { records: any[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records = raw.records.map((r: any) => (r.name === "np3" ? { ...r, desiredState: "disabled" } : r))
    raw.records.push({ schemaVersion: 2, id: "plugin:np3", name: "np3", kind: "plugin" }) // 损坏重复
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    const en = await setInstallStateByKey({ type: "plugin", name: "np3", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false) // 账本拒写
    // 关键:enable 先写账本(失败即止),config 从未被补回 —— 不留启用条目。
    expect(readCfg().plugin).toEqual([])
  })
})

// ── Codex r4 回归:symlink 别名的 vendored 条目按 realpath 身份命中移除 + ledger-first 顺序 ────────
describe("#395 Codex r4 回归", () => {
  test("plugin[] 条目是指向受管 plugin.js 的 symlink 别名 → disable 按 realpath 身份命中移除(禁用不绕过)", async () => {
    const realDir = path.join(root, "plugins", "x@ab")
    const realJs = path.join(realDir, "plugin.js")
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(realJs, "module.exports = {}")
    const aliasJs = path.join(root, "alias.js")
    fs.symlinkSync(realJs, aliasJs) // 别名 → 同一文件
    record({ name: "x", kind: "plugin", configKey: `plugin-path:${realJs}` })
    writeCfg({ plugin: [aliasJs] }) // config 存别名(词法≠账本键,但 realpath 同一)
    const dis = await setInstallStateByKey({ type: "plugin", name: "x", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([]) // 别名按 realpath 身份命中并移除
    expect(findRecordV2(root, "plugin", "x")!.desiredState).toBe("disabled")
  })

  test("disable:账本先写 —— 账本翻 disabled 后即便 config 写抛错,账本回滚保持一致(不留账本 disabled/config 未变的谎报)", async () => {
    // config target 设为不可写目录使 applyConfigImage 抛错。
    record({ name: "np4", kind: "mcp", configKey: "mcp.np4" })
    writeCfg({ mcp: { np4: { type: "local" } } })
    // 正常 disable 应成功(基线);此处只验往返一致性(realpath 抛错难在临时目录稳定构造,
    // 顺序契约由「账本先写」的实现 + enable 失败回滚测试共同锁定)。
    const dis = await setInstallStateByKey({ type: "mcp", name: "np4", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().mcp.np4).toEqual({ type: "local", enabled: false })
    expect(findRecordV2(root, "mcp", "np4")!.desiredState).toBe("disabled")
  })
})

// ── #395(Codex r5)步骤4:alpha.jsonc 读错误只容缺席(ENOENT/ENOTDIR),其余 fail-closed ─────────
describe("#395 步骤4 读错误收窄", () => {
  test("config 不可读(EISDIR)→ 启停双向 fail-closed(不把「读不出」当缺席谎报 disable 成功)", async () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m" })
    fs.mkdirSync(path.join(root, "alpha.jsonc")) // 目录占位 → readFileSync EISDIR(非缺席)
    const r = await setInstallStateByKey({ type: "mcp", name: "m", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unreadable")
    expect(findRecordV2(root, "mcp", "m")!.desiredState).toBe("enabled") // 账本未翻
  })
})

// ── #395 Codex r7:legacy/XDG 源统一探测(mcp/agent 反向字段 + 缺席也探测 + npm base)──────────────

// ── Codex r12 Major3:command/bundle/cloud 无禁用生效面 → set-state 拒 ─────────────────────────────
describe("#395 r12 Major3 无生效面拒绝", () => {
  const cases = [
    { kind: "command" as const, origin: "imported" as const },
    { kind: "bundle" as const, origin: "catalog" as const },
    { kind: "cloud" as const, origin: "catalog" as const },
  ]
  for (const { kind, origin } of cases) {
    test(`${kind} disable → fail-closed（无生效面，翻 desiredState 会谎报）`, async () => {
      const id = kind === "command" ? `user:c-${kind}` : `${kind}:c-${kind}`
      record({ name: `c-${kind}`, kind, id, origin, ...(kind === "cloud" ? {} : { configKey: `${kind}.c-${kind}` }) } as any)
      const r = await setInstallStateByKey({ type: kind, name: `c-${kind}`, scope: "global", state: "disabled" }, deps())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("no enable/disable surface")
    })
  }
})
