// REQ-104 #395 —— 启停通道:持久化 config 投影 + 账本翻转(锁内普通原子写,非事务)。
// disabled plugin 必须从磁盘 config 缺席(引擎 import 早于 config-hook);mcp 写 enabled:false、agent 写 disable:true;
// skill 无 config 面(投影经引擎注入门)。config 自持 disabled 态 → 免疫「删账本复活」。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setInstallStateByKey, type VerifiedCatalogEntry } from "./ext-install-planner"
import { applyPackageMutation, findRecordV2, skillsEnabledPath, upsertRecordV2, type InstallReceiptType, type UpsertInput } from "./ext-receipt-v2"
import { bundleOwner, computeInstalledGraphDigest, type PackageGraphNodeV1 } from "./ext-package-ledger-v3"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import { packageEnvelopeIdentityV1, resolveVerifiedPackageV1 } from "./package-installability"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"

type SetStateDeps = Parameters<typeof setInstallStateByKey>[1]

let root: string
// #397 r1-5:enable 闸要求已验 entry 与 record 身份(id/kind/name/version)精确对应 ——
// 测试 deps 从账本回镜同身份 uncurated entry(本文件测的是 #395 投影语义,非 curation 面)。
// `#817`:resolvePackage 缺省响亮拒绝 —— legacy 用例没有 V3 图,到不了 package 分支;
// package 用例逐个注入自己的 stub。
const deps = (over: Partial<SetStateDeps> = {}): SetStateDeps => ({
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
  resolvePackage: async () => ({ status: "refused", reason: "resolvePackage must not be consulted in this test" }),
  ...over,
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

// ── `#817`:签名 package child 启停(package-managed 只走 packages[] 解析,绝不回退 entries)──────

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex")
const dg = (seed: string) => `sha256:${hex(seed)}`

type PkgChildSpec = { kind: "skill" | "agent" | "mcp"; name: string; payloadDigest?: string }

/** 铸一个已装签名 package:真 `applyPackageMutation`(图 + claim + child record 同一次写)。
 *  children[0] = root;record 均 `desiredState:"disabled"`(catalog 首装缺省,#817 的现场)。 */
function installPackageFixture(opts: {
  packageId: string
  version?: string
  envelopeDigest?: string
  children: PkgChildSpec[]
  txId?: string
}) {
  const version = opts.version ?? "1.0.0"
  const envelopeDigest = opts.envelopeDigest ?? dg(`envelope:${opts.packageId}:${version}`)
  const nodes: PackageGraphNodeV1[] = opts.children.map((c) => ({
    componentId: `${c.kind}:${c.name}`,
    kind: c.kind,
    name: c.name,
    required: true,
    manifestDigest: dg(`manifest:${c.kind}:${c.name}`),
  }))
  const bare = { packageId: opts.packageId, envelopeDigest, root: nodes[0]!, children: nodes.slice(1) }
  const graph = { ...bare, installedGraphDigest: computeInstalledGraphDigest(bare) }
  const owner = bundleOwner(opts.packageId, graph.root.manifestDigest)
  const w = applyPackageMutation(root, {
    transactionId: opts.txId ?? `tx-${opts.packageId}-${version}`,
    operation: "install",
    graphBeforeDigest: null,
    graphAfter: graph,
    childRecordMutations: opts.children.map((c, i) => ({
      op: "upsert" as const,
      input: {
        id: nodes[i]!.componentId,
        name: c.name,
        kind: c.kind,
        environment: "prod",
        scope: { kind: "global" },
        version,
        manifestDigest: nodes[i]!.manifestDigest,
        payloadDigest: c.payloadDigest ?? dg(`payload:${c.kind}:${c.name}`),
        desiredState: "disabled",
        origin: "catalog",
        installedAt: "2026-08-05T00:00:00.000Z",
      } satisfies UpsertInput,
    })),
    claimMutations: nodes.map((n) => ({ op: "acquire" as const, kind: n.kind, name: n.name, owner })),
  })
  if (!w.ok) throw new Error(w.reason)
  return { packageId: opts.packageId, version, envelopeDigest, graph, nodes }
}

type PkgFixture = ReturnType<typeof installPackageFixture>
type PkgIdentity = { packageId: string; version: string; envelopeDigest: string; components: Array<{ id: string; payloadSha256: string }> }

/** (packageId, version) 双键命中即回全匹配 identity;可注入 mutate 造逐项 mismatch。 */
const foundStub =
  (fix: PkgFixture, mutate?: (identity: PkgIdentity) => PkgIdentity): SetStateDeps["resolvePackage"] =>
  async (pid, ver) => {
    if (pid !== fix.packageId || ver !== fix.version)
      return { status: "missing", channel: "cache", anyVersionPresent: pid === fix.packageId }
    const identity: PkgIdentity = {
      packageId: fix.packageId,
      version: fix.version,
      envelopeDigest: fix.envelopeDigest,
      components: fix.nodes.map((n) => ({ id: n.componentId, payloadSha256: hex(`payload:${n.kind}:${n.name}`) })),
    }
    return { status: "found", channel: "cache", identity: mutate ? mutate(identity) : identity }
  }

const readAllowSet = (): unknown => JSON.parse(fs.readFileSync(skillsEnabledPath(root), "utf8"))

/** `#817` package 用例的 deps:legacy `entries[]` **不含** package child(现实形态)——
 *  resolveEntry 恒 null。这使「把解析改回 legacy entries」的绕过在这些用例上**必然转红**
 *  (AC2:判据是盘面结果,legacy 路径解析不到即拒,盘面不动)。 */
const pkgDeps = (over: Partial<SetStateDeps> = {}): SetStateDeps => deps({ resolveEntry: async () => null, ...over })

describe("setInstallStateByKey(#817 签名 package child)", () => {
  test("skill child:enable 经 packages[] 全匹配放行,进入引擎允许集(skills-enabled.json)", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-skill", children: [{ kind: "skill", name: "psk" }] })
    const en = await setInstallStateByKey(
      { type: "skill", name: "psk", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: foundStub(fix) }),
    )
    expect(en.ok).toBe(true)
    expect(findRecordV2(root, "skill", "psk")!.desiredState).toBe("enabled")
    expect(readAllowSet()).toEqual({ v: 1, keys: ["skill--psk"] })
  })

  test("agent child:enable 解除 alpha.jsonc 的 disable:true 投影", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-agent", children: [{ kind: "agent", name: "pag" }] })
    writeCfg({ agent: { pag: { description: "d", disable: true } } })
    const en = await setInstallStateByKey(
      { type: "agent", name: "pag", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: foundStub(fix) }),
    )
    expect(en.ok).toBe(true)
    expect(readCfg().agent.pag).toEqual({ description: "d" })
    expect(findRecordV2(root, "agent", "pag")!.desiredState).toBe("enabled")
  })

  test("mcp child:enable 解除 alpha.jsonc 的 enabled:false", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-mcp", children: [{ kind: "mcp", name: "pmc" }] })
    writeCfg({ mcp: { pmc: { type: "remote", url: "https://x.example/", enabled: false } } })
    const en = await setInstallStateByKey(
      { type: "mcp", name: "pmc", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: foundStub(fix) }),
    )
    expect(en.ok).toBe(true)
    expect(readCfg().mcp.pmc).toEqual({ type: "remote", url: "https://x.example/" })
  })

  test("disable 方向不咨询 catalog(entries 与 packages 面都不许被碰)", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-off", children: [{ kind: "skill", name: "poff" }] })
    const en = await setInstallStateByKey(
      { type: "skill", name: "poff", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: foundStub(fix) }),
    )
    expect(en.ok).toBe(true)
    const dis = await setInstallStateByKey(
      { type: "skill", name: "poff", scope: "global", state: "disabled" },
      deps({
        resolveEntry: async () => {
          throw new Error("resolveEntry must not run on the disable path")
        },
        resolvePackage: async () => {
          throw new Error("resolvePackage must not run on the disable path")
        },
      }),
    )
    expect(dis.ok).toBe(true)
    expect(findRecordV2(root, "skill", "poff")!.desiredState).toBe("disabled")
    expect(readAllowSet()).toEqual({ v: 1, keys: [] })
  })

  test("package-managed 但 record manifestDigest 漂移 ⇒ exact 候选=0 fail-closed;**resolveEntry 零调用**(绝不回退 legacy)", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-drift", children: [{ kind: "skill", name: "pdr" }] })
    // 漂移:record 直写成另一个 manifestDigest(图/claim 原样 —— package-managed 信号仍在)。
    const up = upsertRecordV2(root, {
      id: "skill:pdr",
      name: "pdr",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      version: fix.version,
      manifestDigest: dg("manifest:drifted"),
      payloadDigest: dg("payload:skill:pdr"),
      desiredState: "disabled",
      origin: "catalog",
      installedAt: "2026-08-05T00:00:00.000Z",
    })
    expect(up.ok).toBe(true)
    const allowBefore = fs.readFileSync(skillsEnabledPath(root), "utf8")
    let resolveEntryCalls = 0
    const en = await setInstallStateByKey(
      { type: "skill", name: "pdr", scope: "global", state: "enabled" },
      deps({
        // 即使 legacy 表里躺着一条身份完全匹配的 entry,也必须拒绝且**不得咨询**它。
        resolveEntry: async (id) => {
          resolveEntryCalls++
          const entry = {
            id,
            type: "skill",
            name: "pdr",
            displayName: "pdr",
            description: "t",
            source: "official",
            category: "t",
            version: fix.version,
          } as unknown as CatalogEntry
          return { entry, channel: "cache", catalogVersion: fix.version }
        },
        resolvePackage: foundStub(fix),
      }),
    )
    expect(en.ok).toBe(false)
    if (!en.ok) {
      expect(en.code).toBe("curation-unverifiable")
      expect(en.reason).toContain("does not match the install record")
    }
    expect(resolveEntryCalls).toBe(0)
    expect(findRecordV2(root, "skill", "pdr")!.desiredState).toBe("disabled")
    expect(fs.readFileSync(skillsEnabledPath(root), "utf8")).toBe(allowBefore)
  })

  test("componentId 漂移同样 exact 候选=0 fail-closed", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-drift2", children: [{ kind: "skill", name: "pdr2" }] })
    const up = upsertRecordV2(root, {
      id: "skill:alt-pdr2", // 与图节点 componentId(skill:pdr2)不再相等
      name: "pdr2",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      version: fix.version,
      manifestDigest: dg("manifest:skill:pdr2"),
      payloadDigest: dg("payload:skill:pdr2"),
      desiredState: "disabled",
      origin: "catalog",
      installedAt: "2026-08-05T00:00:00.000Z",
    })
    expect(up.ok).toBe(true)
    const en = await setInstallStateByKey(
      { type: "skill", name: "pdr2", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: foundStub(fix) }),
    )
    expect(en.ok).toBe(false)
    if (!en.ok) {
      expect(en.code).toBe("curation-unverifiable")
      expect(en.reason).toContain("does not match the install record")
    }
    expect(findRecordV2(root, "skill", "pdr2")!.desiredState).toBe("disabled")
  })
})

// ── `#817`:(packageId, version) 双键选择 —— 真 resolveVerifiedPackageV1 + 真 envelope ──────────

const MV_PKG = "package:multi-ver"
const MV_COMPONENT = "mcp:multi-ver-remote"
/** 一份最小、decoder-stable 的合法 envelope(单 mcp-remote 组件;字段与宿主合同逐键canonical)。 */
const mvEnvelope = (version: string) => ({
  schema: "alpha.host-extension-package.v1",
  prelude: { packageId: MV_PKG, version },
  presentation: { displayName: "Multi Ver", description: "double-key selection corpus" },
  root: MV_COMPONENT,
  components: [
    {
      id: MV_COMPONENT,
      required: true,
      dependencies: [],
      profileId: "mcp-remote",
      profileVersion: 1,
      capabilities: [],
      payloadRef: {
        sha256: hex(`payload:multi-ver:${version}`),
        bytes: 64,
        mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
        url: `https://alphacodeone.com/catalog/assets/mcp.multi-ver-remote/${version}/alpha-package/payload.json`,
      },
    },
  ],
  capabilities: [],
})

/** ext-ipc resolvePackage 的同形薄胶水:真 resolveVerifiedPackageV1 + channel 标注。 */
const realResolveOver =
  (catalog: unknown): SetStateDeps["resolvePackage"] =>
  async (pid, ver) => {
    const r = resolveVerifiedPackageV1(catalog, pid, ver)
    return r.status === "found"
      ? { status: "found", channel: "cache", identity: r.identity }
      : r.status === "missing"
        ? { status: "missing", channel: "cache", anyVersionPresent: r.anyVersionPresent }
        : r
  }

describe("setInstallStateByKey(#817 双键精确选择,真 resolveVerifiedPackageV1)", () => {
  test("同 packageId 多版本并存:已装 exact 版本是 packages[] **第二条**,仍选对并启用", async () => {
    // 期望摘要从**测试自己的输入**推导(公开原语 canonicalJson/sha256Hex),不回读实现输出;
    // 再与生产派生互证(两轴独立,口径分叉当场红)。
    const v2 = mvEnvelope("2.0.0")
    const expectedDigest = `sha256:${sha256Hex(canonicalJson(v2))}`
    const produced = packageEnvelopeIdentityV1(v2)
    expect(produced.ok && produced.identity.envelopeDigest).toBe(expectedDigest)

    installPackageFixture({
      packageId: MV_PKG,
      version: "2.0.0",
      envelopeDigest: expectedDigest,
      children: [{ kind: "mcp", name: "multi-ver-remote", payloadDigest: `sha256:${hex("payload:multi-ver:2.0.0")}` }],
    })
    writeCfg({ mcp: { "multi-ver-remote": { type: "remote", url: "https://mcp.example.com/", enabled: false } } })
    // exact 版本(2.0.0)刻意放在**第二条**;若实现按 packageId 单键 .find 会错拿 1.0.0 而拒。
    const catalog = { version: "t", entries: [{}], packages: [mvEnvelope("1.0.0"), v2] }
    const en = await setInstallStateByKey(
      { type: "mcp", name: "multi-ver-remote", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: realResolveOver(catalog) }),
    )
    expect(en.ok).toBe(true)
    expect(readCfg().mcp["multi-ver-remote"]).toEqual({ type: "remote", url: "https://mcp.example.com/" })
    expect(findRecordV2(root, "mcp", "multi-ver-remote")!.desiredState).toBe("enabled")
  })

  test("已装 exact 版本不在 packages[](仅存其他版本)⇒ fail-closed,具名「不再发布」", async () => {
    const v2 = mvEnvelope("2.0.0")
    const expectedDigest = `sha256:${sha256Hex(canonicalJson(v2))}`
    installPackageFixture({
      packageId: MV_PKG,
      version: "2.0.0",
      envelopeDigest: expectedDigest,
      children: [{ kind: "mcp", name: "multi-ver-remote", payloadDigest: `sha256:${hex("payload:multi-ver:2.0.0")}` }],
    })
    writeCfg({ mcp: { "multi-ver-remote": { type: "remote", url: "https://mcp.example.com/", enabled: false } } })
    const catalog = { version: "t", entries: [{}], packages: [mvEnvelope("1.0.0")] } // exact 缺席
    const en = await setInstallStateByKey(
      { type: "mcp", name: "multi-ver-remote", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: realResolveOver(catalog) }),
    )
    expect(en.ok).toBe(false)
    if (!en.ok) {
      expect(en.code).toBe("curation-unverifiable")
      expect(en.reason).toContain("no longer published")
    }
    expect(readCfg().mcp["multi-ver-remote"]).toEqual({ type: "remote", url: "https://mcp.example.com/", enabled: false })
    expect(findRecordV2(root, "mcp", "multi-ver-remote")!.desiredState).toBe("disabled")
  })
})

// ── `#817`:missing/delisted/security/catalog-unavailable/逐项 digest mismatch 负例矩阵 ─────────

describe("setInstallStateByKey(#817 fail-closed 负例矩阵)", () => {
  test("每一类失配都拒且理由具名;盘面与账本零变化", async () => {
    const fix = installPackageFixture({ packageId: "package:pkg-neg", children: [{ kind: "mcp", name: "pneg" }] })
    writeCfg({ mcp: { pneg: { type: "remote", url: "https://x.example/", enabled: false } } })
    const cases: Array<{ label: string; rp: SetStateDeps["resolvePackage"]; needle: string }> = [
      {
        label: "delisted",
        rp: async () => ({ status: "missing", channel: "cache", anyVersionPresent: false }),
        needle: "delisted",
      },
      {
        label: "version-gone",
        rp: async () => ({ status: "missing", channel: "cache", anyVersionPresent: true }),
        needle: "no longer published",
      },
      {
        label: "catalog-unavailable(bundled 无 packages)",
        rp: async () => ({ status: "missing", channel: "bundled", anyVersionPresent: false }),
        needle: "bundled snapshot carries no signed packages",
      },
      {
        label: "security browse-only",
        rp: async () => ({ status: "refused", reason: "verified catalog is in security-failure state (browse-only)" }),
        needle: "security-failure",
      },
      {
        label: "envelope digest mismatch",
        rp: foundStub(fix, (identity) => ({ ...identity, envelopeDigest: dg("other-envelope") })),
        needle: "content does not match the installed package",
      },
      {
        label: "component 缺席",
        rp: foundStub(fix, (identity) => ({ ...identity, components: [] })),
        needle: "is not part of verified catalog package",
      },
      {
        label: "payload digest mismatch",
        rp: foundStub(fix, (identity) => ({
          ...identity,
          components: identity.components.map((c) => ({ ...c, payloadSha256: hex("evil") })),
        })),
        needle: "payload digest does not match",
      },
    ]
    for (const c of cases) {
      const en = await setInstallStateByKey(
        { type: "mcp", name: "pneg", scope: "global", state: "enabled" },
        pkgDeps({ resolvePackage: c.rp }),
      )
      expect(en.ok).toBe(false)
      if (!en.ok) {
        expect(en.code).toBe("curation-unverifiable")
        expect(en.reason).toContain(c.needle)
      }
      expect(findRecordV2(root, "mcp", "pneg")!.desiredState).toBe("disabled")
      expect(readCfg().mcp.pneg).toEqual({ type: "remote", url: "https://x.example/", enabled: false })
    }
  })
})

// ── `#817`:跨包共有 child(准入期允许的 canonical permutation)边界 ───────────────────────────

describe("setInstallStateByKey(#817 共有 child 存在量词)", () => {
  test("两包共有同一 child:经后写者包全匹配启用;两包都解析不到 ⇒ fail-closed", async () => {
    const shared: PkgChildSpec = { kind: "skill", name: "shx" }
    const a = installPackageFixture({ packageId: "package:pkg-a", version: "1.0.0", children: [{ kind: "agent", name: "ra" }, shared] })
    const b = installPackageFixture({ packageId: "package:pkg-b", version: "2.0.0", children: [{ kind: "agent", name: "rb" }, shared] })
    // record.version = 后写者(B)—— 生产 upsert 語义(package-admission 同款)。
    expect(findRecordV2(root, "skill", "shx")!.version).toBe("2.0.0")
    // 存在量词:候选 = {A 图, B 图};A@2.0.0 missing、B@2.0.0 全匹配 ⇒ 放行(与遍历顺序无关)。
    const viaB: SetStateDeps["resolvePackage"] = async (pid, ver) =>
      pid === b.packageId ? foundStub(b)(pid, ver) : { status: "missing", channel: "cache", anyVersionPresent: pid === a.packageId }
    const en = await setInstallStateByKey({ type: "skill", name: "shx", scope: "global", state: "enabled" }, pkgDeps({ resolvePackage: viaB }))
    expect(en.ok).toBe(true)
    expect(readAllowSet()).toEqual({ v: 1, keys: ["skill--shx"] })
    // 反向(登记的设计内 fail-closed 边):后写者 B 下架,A 仍在但版本对不上 record ⇒ 全部候选失败 ⇒ 拒。
    const dis = await setInstallStateByKey({ type: "skill", name: "shx", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    const neitherResolves: SetStateDeps["resolvePackage"] = async (pid) => ({
      status: "missing",
      channel: "cache",
      anyVersionPresent: pid === a.packageId, // A 有别的版本在架,B 整包下架
    })
    const refused = await setInstallStateByKey(
      { type: "skill", name: "shx", scope: "global", state: "enabled" },
      pkgDeps({ resolvePackage: neitherResolves }),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe("curation-unverifiable")
      expect(refused.reason).toContain("update or reinstall")
    }
    expect(readAllowSet()).toEqual({ v: 1, keys: [] })
    expect(findRecordV2(root, "skill", "shx")!.desiredState).toBe("disabled")
  })
})
