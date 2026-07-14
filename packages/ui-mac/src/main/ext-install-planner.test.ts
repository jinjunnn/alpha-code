// REQ-099(issue #191 / ADR-028 §1/§2/§5)—— main-only 安装计划单测:
//  · AC#2 伪造 renderer 事实(server config/包名/路径/整张 receipt)没有通道 —— 未知意图键 loud 拒绝,
//    安装事实全部从已验 catalog 重新派生;
//  · AC#1 合成 manifest 写盘前严格校验(非法 manifest / 平台不兼容 / 循环依赖在任何 installer 调用之前拒绝);
//  · AC#3 global 与多项目同名安装互不影响(账本物理分域 + scope identity);
//  · AC#4 项目移动 / identity 不符 fail closed,绝不退化为 global 卸载;
//  · REQ-100 事务接缝(begin/commit/rollback)与孤儿密钥回收。
// 依赖注入假 installer(仓规:零 mock.module);账本走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { addReceipt } from "./alpha-installs"
import { aggregateFilesDigest, computeManifestDigest, decodeManifestV2 } from "./ext-manifest-v2"
import { computeGrantDigest, findRecordV2, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"
import { resolveLiveGenerationDir } from "./ext-transaction"
import {
  decodeCatalogInstallIntent,
  decodeSetStateIntent,
  decodeUninstallIntent,
  deriveMcpConfig,
  installCatalog,
  setInstallStateByKey,
  synthesizeManifest,
  uninstallByKey,
  type InstallTransactionHooks,
  type PlannerDeps,
  type PlannerInstallers,
  type VerifiedCatalogEntry,
} from "./ext-install-planner"

let tmp: string
let globalRoot: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-planner-"))
  globalRoot = path.join(tmp, "global")
  fs.mkdirSync(globalRoot, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── catalog fixtures(已验 catalog 侧的条目;renderer 无从改写)─────────────────────────────────

const base = { displayName: "d", description: "d", source: "official" as const, category: "test" }

const mcpEntry: CatalogEntry = {
  id: "mcp:markitdown",
  type: "mcp",
  name: "markitdown",
  ...base,
  version: "1.0.0",
  installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"], requiredEnvVars: ["API_KEY"] },
}
const mcpWorkspaceEntry: CatalogEntry = {
  id: "mcp:excel",
  type: "mcp",
  name: "excel-mcp",
  ...base,
  version: "0.1.8",
  installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "excel-mcp-server@0.1.8", "{workspace}"] },
}
const mcpRemoteEntry: CatalogEntry = {
  id: "mcp:linear",
  type: "mcp",
  name: "linear",
  ...base,
  version: "2.0.0",
  installSpec: { kind: "mcp", mcpType: "remote", url: "https://mcp.linear.app/sse", headersTemplate: { Authorization: "Bearer {API_KEY}" }, requiredEnvVars: ["API_KEY"] },
}
const skillBuiltinEntry: CatalogEntry = {
  id: "skill:demo",
  type: "skill",
  name: "demo",
  ...base,
  version: "1.0.0",
  installSpec: { kind: "skill", source: "builtin", builtinAssetKey: "skills/demo", targetDir: "alpha-skills" },
}
const remoteFiles = [{ path: "SKILL.md", sha256: "c".repeat(64), bytes: 5, url: "https://assets.example/SKILL.md" }]
const skillRemoteEntry: CatalogEntry = {
  id: "skill:remote-demo",
  type: "skill",
  name: "remote-demo",
  ...base,
  version: "1.2.0",
  installSpec: { kind: "skill", source: "remote", targetDir: "alpha-skills" },
  remoteAsset: { version: "1.2.0", files: remoteFiles },
}
const pluginVendoredEntry: CatalogEntry = {
  id: "plugin:vp",
  type: "plugin",
  name: "vp",
  ...base,
  version: "1.0.0",
  installSpec: { kind: "plugin", package: "@alpha/vp", vendoredAssetKey: "plugins/vp" },
}
const pluginNpmEntry: CatalogEntry = {
  id: "plugin:np",
  type: "plugin",
  name: "np",
  ...base,
  version: "2.3.4",
  installSpec: { kind: "plugin", package: "@alpha/np", version: "2.3.4" },
}
const cloudEntry: CatalogEntry = {
  id: "cloud:research",
  type: "cloud",
  name: "research",
  ...base,
  version: "1.0.0",
  installSpec: { kind: "cloud", pipelineKind: "research" },
}
const bundleEntry: CatalogEntry = {
  id: "bundle:office",
  type: "bundle",
  name: "office",
  ...base,
  version: "1.0.0",
  bundleItems: [
    { catalogEntryId: "mcp:markitdown", optional: false, installOrder: 2 },
    { catalogEntryId: "skill:demo", optional: false, installOrder: 1 },
  ],
}

const ALL_ENTRIES = [mcpEntry, mcpWorkspaceEntry, mcpRemoteEntry, skillBuiltinEntry, skillRemoteEntry, pluginVendoredEntry, pluginNpmEntry, cloudEntry, bundleEntry]

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] }

function makeDeps(opts: {
  entries?: CatalogEntry[]
  platform?: NodeJS.Platform
  installers?: Partial<PlannerInstallers>
  transaction?: InstallTransactionHooks
} = {}): { deps: PlannerDeps; calls: Call[] } {
  const calls: Call[] = []
  const record = <T>(fn: string, ret: T) => (...args: unknown[]): T => {
    calls.push({ fn, args })
    return ret
  }
  const installers: PlannerInstallers = {
    persistMcp: record("persistMcp", { ok: true as const }),
    fileifyMcpSecrets: record("fileifyMcpSecrets", undefined),
    removeMcpSecrets: record("removeMcpSecrets", undefined),
    removeMcp: record("removeMcp", { ok: true as const }),
    persistPlugin: record("persistPlugin", { ok: true as const }),
    removePlugin: record("removePlugin", { ok: true as const }),
    installVendoredPlugin: (key, name) => {
      calls.push({ fn: "installVendoredPlugin", args: [key, name] })
      return { ok: true, files: [path.join(globalRoot, "plugins", name)] }
    },
    removePluginPath: record("removePluginPath", { ok: true as const }),
    installBuiltinSkill: record("installBuiltinSkill", { ok: true as const, files: ["/derived/skill"] }),
    collectBuiltinSkillPayload: (key: string, name: string) => {
      calls.push({ fn: "collectBuiltinSkillPayload", args: [key, name] })
      return { ok: true as const, files: [{ path: "SKILL.md", data: Buffer.from(`---\nname: ${name}\n---\nbody`) }] }
    },
    installBuiltinAgent: record("installBuiltinAgent", { ok: true as const, files: ["/derived/agent"] }),
    installRemoteSkill: record("installRemoteSkill", { ok: true as const, files: ["/derived/remote-skill"] }),
    installRemoteAgent: record("installRemoteAgent", { ok: true as const, files: ["/derived/remote-agent"] }),
    removeFsInstall: record("removeFsInstall", { ok: true as const, files: [] }),
    downloadRemoteAsset: async (files) => {
      calls.push({ fn: "downloadRemoteAsset", args: [files] })
      return { ok: true, contents: [{ path: "SKILL.md", data: Buffer.from("body") }] }
    },
    ...opts.installers,
  }
  const entries = opts.entries ?? ALL_ENTRIES
  const deps: PlannerDeps = {
    resolveEntry: async (catalogId) => {
      const entry = entries.find((e) => e.id === catalogId)
      return entry ? { entry, channel: "remote", catalogVersion: "2026-07-13.1" } : null
    },
    environment: () => "prod",
    platform: () => opts.platform ?? "darwin",
    globalRoot: () => globalRoot,
    installers,
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  }
  return { deps, calls }
}

const called = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn)
const installerCallCount = (calls: Call[]) => calls.length

function makeProject(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

// ── intent 严格解码(AC#2:伪造事实无通道)──────────────────────────────────────────────────────

describe("intent decoding — forged renderer facts have no channel (AC#2)", () => {
  test("install intent: renderer-supplied server config / package / name / files refused", () => {
    for (const forged of [
      { catalogId: "mcp:markitdown", scope: { scope: "global" }, server: { type: "local", command: ["evil"] } },
      { catalogId: "mcp:markitdown", scope: { scope: "global" }, package: "evil-pkg" },
      { catalogId: "mcp:markitdown", scope: { scope: "global" }, name: "shadow-name" },
      { catalogId: "mcp:markitdown", scope: { scope: "global" }, files: ["/etc/passwd"] },
      { catalogId: "mcp:markitdown", scope: { scope: "global" }, builtinAssetKey: "../../escape" },
    ]) {
      const decoded = decodeCatalogInstallIntent(forged)
      expect(decoded.ok).toBe(false)
      if (!decoded.ok) expect(decoded.reason).toContain("unknown key")
    }
  })

  test("grants: unknown grant keys refused; scope strict", () => {
    const rogueGrant = decodeCatalogInstallIntent({ catalogId: "x", scope: { scope: "global" }, grants: { command: ["evil"] } })
    expect(rogueGrant.ok).toBe(false)
    const rogueScope = decodeCatalogInstallIntent({ catalogId: "x", scope: { scope: "global", projectDir: "/p" } })
    expect(rogueScope.ok).toBe(false)
    const relDir = decodeCatalogInstallIntent({ catalogId: "x", scope: { scope: "project", projectDir: "not/abs" } })
    expect(relDir.ok).toBe(false)
    const ok = decodeCatalogInstallIntent({ catalogId: "x", scope: { scope: "global" }, grants: { secrets: { K: "v" }, cnMirror: true } })
    expect(ok.ok).toBe(true)
  })

  test("uninstall intent: renderer-supplied receipt fields (files/configKey/receipt) refused", () => {
    for (const forged of [
      { type: "skill", name: "demo", scope: "global", files: ["/abs/anything"] },
      { type: "mcp", name: "m", scope: "global", configKey: "mcp.other" },
      { type: "plugin", name: "p", scope: "global", receipt: { files: ["/etc"] } },
    ]) {
      const decoded = decodeUninstallIntent(forged)
      expect(decoded.ok).toBe(false)
      if (!decoded.ok) expect(decoded.reason).toContain("unknown key")
    }
    expect(decodeUninstallIntent({ type: "skill", name: "demo", scope: "global", projectDir: "/p" }).ok).toBe(false)
    expect(decodeUninstallIntent({ type: "skill", name: "demo", scope: "project" }).ok).toBe(false)
    expect(decodeUninstallIntent({ type: "skill", name: "demo", scope: "global" }).ok).toBe(true)
  })

  test("set-state intent: same key surface + state enum", () => {
    expect(decodeSetStateIntent({ type: "skill", name: "demo", scope: "global", state: "paused" }).ok).toBe(false)
    expect(decodeSetStateIntent({ type: "skill", name: "demo", scope: "global", state: "disabled", files: [] }).ok).toBe(false)
    expect(decodeSetStateIntent({ type: "skill", name: "demo", scope: "global", state: "disabled" }).ok).toBe(true)
  })
})

// ── manifest 合成 + 写盘前拒绝(AC#1)───────────────────────────────────────────────────────────

describe("manifest synthesis & pre-disk refusal (AC#1)", () => {
  test("synthesized manifest decodes strictly; five-dimension ownership(curated ≠ authored)", () => {
    const verified: VerifiedCatalogEntry = { entry: mcpEntry, channel: "remote", catalogVersion: "2026-07-13.1" }
    const decoded = decodeManifestV2(synthesizeManifest(verified))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.manifest.ownership.authored).toBe("official")
    expect(decoded.manifest.ownership.curated).toBe("alpha")
    expect(decoded.manifest.ownership.supportTier).toBe("curated")
    expect(decoded.manifest.ownership.distributed).toBe("engine-config")
    expect(decoded.manifest.components[0]!.runsIn).toEqual(["local-subprocess"])
  })

  test("invalid synthesized manifest refused BEFORE any installer call", async () => {
    const badEntry: CatalogEntry = { ...mcpEntry, id: "mcp:bad", name: "bad name!" }
    const { deps, calls } = makeDeps({ entries: [badEntry] })
    const r = await installCatalog({ catalogId: "mcp:bad", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing before any disk write")
    expect(installerCallCount(calls)).toBe(0)
    expect(fs.existsSync(path.join(globalRoot, "installs.json"))).toBe(false)
  })

  test("platform incompatibility refused before any installer call", async () => {
    const { deps, calls } = makeDeps({ platform: "linux" })
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("platform linux not supported")
    expect(installerCallCount(calls)).toBe(0)
  })

  test("entry not in verified catalog refused; zero side effects", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:ghost", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not in verified catalog")
    expect(installerCallCount(calls)).toBe(0)
  })
})

// ── MCP:grants 校验 + main 重建配置 ────────────────────────────────────────────────────────────

describe("MCP install — facts re-derived from catalog, grants validated", () => {
  test("happy path: config derived from CATALOG command; secrets fileified; record written", async () => {
    const { deps, calls } = makeDeps()
    const grants = { secrets: { API_KEY: "sekret-value" } }
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // live config(renderer 拿去 sdk.mcp.add)含密钥真值 —— 该值本就来自 renderer
    expect(r.liveMcp?.config).toEqual({ type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"], environment: { API_KEY: "sekret-value" } })
    const fileify = called(calls, "fileifyMcpSecrets")
    expect(fileify).toHaveLength(1)
    expect(fileify[0]!.args[2]).toEqual(["API_KEY"])
    const persist = called(calls, "persistMcp")
    expect(persist).toHaveLength(1)
    expect(persist[0]!.args[0]).toBe("markitdown") // 名字来自 catalog,不来自 renderer
    expect((persist[0]!.args[1] as { command: string[] }).command).toEqual(["uvx", "markitdown-mcp@0.0.1a4"])
    expect((persist[0]!.args[2] as { catalogId?: string }).catalogId).toBe("mcp:markitdown")
    // v2 record:environment/digests/desiredState/generation 落账
    const record = findRecordV2(globalRoot, "mcp", "markitdown")
    expect(record).not.toBeNull()
    expect(record!.environment).toBe("prod")
    expect(record!.origin).toBe("catalog")
    expect(record!.manifestDigest).toBe(r.manifestDigest!)
    expect(record!.grantDigest).toBe(computeGrantDigest(grants))
    expect(record!.generation).toBe(1)
    expect(record!.transaction?.state).toBe("committed")
  })

  test("grant not declared by catalog entry (requiredEnvVars) refused before installers", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { EVIL_VAR: "x" } } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('grant "EVIL_VAR" not declared')
    expect(called(calls, "persistMcp")).toHaveLength(0)
    expect(called(calls, "fileifyMcpSecrets")).toHaveLength(0)
  })

  test("workspace grant: required when declared, refused when not declared", async () => {
    const { deps } = makeDeps()
    const missing = await installCatalog({ catalogId: "mcp:excel", scope: { scope: "global" } }, deps)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain("workspace grant required")
    const undeclared = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { workspace: "/ws" } }, deps)
    expect(undeclared.ok).toBe(false)
    const { deps: deps2, calls: calls2 } = makeDeps()
    const ok = await installCatalog({ catalogId: "mcp:excel", scope: { scope: "global" }, grants: { workspace: "/ws/excel" } }, deps2)
    expect(ok.ok).toBe(true)
    expect((called(calls2, "persistMcp")[0]!.args[1] as { command: string[] }).command).toEqual(["uvx", "excel-mcp-server@0.1.8", "/ws/excel"])
  })

  test("remote MCP: url from catalog, headers from template + granted secret", async () => {
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:linear", scope: { scope: "global" }, grants: { secrets: { API_KEY: "tok" } } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.liveMcp?.config).toEqual({ type: "remote", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer tok" } })
  })

  test("cnMirror env values are main-side constants (renderer only expresses the preference)", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:excel", scope: { scope: "global" }, grants: { workspace: "/ws", cnMirror: true } }, deps)
    expect(r.ok).toBe(true)
    const env = (called(calls, "persistMcp")[0]!.args[1] as { environment: Record<string, string> }).environment
    expect(env.npm_config_registry).toBe("https://registry.npmmirror.com")
    expect(env.PIP_INDEX_URL).toContain("tuna.tsinghua.edu.cn")
  })

  test("persistMcp failure → orphan secret files revoked + transaction rolled back", async () => {
    const txEvents: string[] = []
    const tx: InstallTransactionHooks = {
      begin: (plan) => {
        txEvents.push(`begin:${plan.op}:${plan.name}`)
        return { txId: "tx-1" }
      },
      commit: (id) => void txEvents.push(`commit:${id}`),
      rollback: (id, reason) => void txEvents.push(`rollback:${id}:${reason}`),
    }
    const { deps, calls } = makeDeps({ transaction: tx, installers: { persistMcp: () => ({ ok: false, reason: "DANGEROUS_ENV" }) } })
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "v" } } }, deps)
    expect(r.ok).toBe(false)
    expect(called(calls, "removeMcpSecrets")).toHaveLength(1) // 不留孤儿密钥文件
    expect(txEvents).toEqual(["begin:install:markitdown", "rollback:tx-1:DANGEROUS_ENV"])
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
  })

  test("mcp cannot be project-scoped (engine config is global)", async () => {
    const proj = makeProject("proj-mcp")
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "project", projectDir: proj } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("cannot be project-scoped")
    expect(installerCallCount(calls)).toBe(0)
  })
})

// ── skill / plugin / cloud / bundle ─────────────────────────────────────────────────────────────

describe("other kinds — derivation & records", () => {
  test("remote skill: download → 不可变 generation 事务;payloadDigest recorded(REQ-100 #310)", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "skill:remote-demo", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "downloadRemoteAsset")[0]!.args[0]).toEqual(remoteFiles)
    // #310:skill 不再走 flat installRemoteSkill,而是 generation 事务 + commitReceipt。
    expect(called(calls, "installRemoteSkill")).toHaveLength(0)
    const record = findRecordV2(globalRoot, "skill", "remote-demo")
    expect(record?.payloadDigest).toBe(aggregateFilesDigest(remoteFiles))
    expect(record?.transaction?.state).toBe("committed")
    // 物理真源 = generation 目录(current.json live)。
    expect(resolveLiveGenerationDir(globalRoot, "skill--remote-demo")).not.toBeNull()
  })

  test("vendored plugin: asset key from catalog; configKey derived from install result", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "installVendoredPlugin")[0]!.args).toEqual(["plugins/vp", "vp"])
    const record = findRecordV2(globalRoot, "plugin", "vp")
    expect(record?.configKey).toBe(`plugin-path:${path.join(globalRoot, "plugins", "vp", "plugin.js")}`)
  })

  test("npm plugin: package pinned from catalog spec", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "persistPlugin")[0]!.args[0]).toBe("@alpha/np@2.3.4")
  })

  test("cloud: receipts-only — record written, zero installer calls", async () => {
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(installerCallCount(calls)).toBe(0)
    expect(findRecordV2(globalRoot, "cloud", "research")).not.toBeNull()
  })

  test("bundle: required secret-MCP child → fail-closed(不在原子边界内,REQ-100 #311)", async () => {
    // bundle:office 的 mcp:markitdown 声明 requiredEnvVars → 首期不支持原子安装 → required 致命 → 整单拒绝。
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "bundle:office", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("required bundle child")
  })

  test("bundle: skill(generation)+ 无密钥 MCP(config)一次原子提交(REQ-100 #311)", async () => {
    const cleanMcp: CatalogEntry = { ...mcpEntry, id: "mcp:clean", name: "clean", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "clean-mcp@1.0.0"] } }
    const cleanBundle: CatalogEntry = { ...bundleEntry, id: "bundle:clean", name: "cleanb", bundleItems: [{ catalogEntryId: "skill:demo", optional: false, installOrder: 1 }, { catalogEntryId: "mcp:clean", optional: false, installOrder: 2 }] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, cleanMcp, cleanBundle] })
    const r = await installCatalog({ catalogId: "bundle:clean", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.installed?.sort()).toEqual(["mcp:clean", "skill:demo"])
    expect(resolveLiveGenerationDir(globalRoot, "skill--demo")).not.toBeNull() // skill 进 generation
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    expect(cfg.mcp.clean).toEqual({ type: "local", command: ["uvx", "clean-mcp@1.0.0"] }) // MCP 进 config
    expect(findRecordV2(globalRoot, "skill", "demo")).not.toBeNull()
    expect(findRecordV2(globalRoot, "mcp", "clean")).not.toBeNull()
  })

  test("bundle: 项目 scope 拒绝(单 root 原子性,REQ-100 #311)", async () => {
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "bundle:office", scope: { scope: "project", projectDir: "/tmp/proj" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("global-scoped only")
  })

  test("bundle: dependency cycle refused at plan time (AC#1)", async () => {
    const bundleA: CatalogEntry = { ...bundleEntry, id: "bundle:a", name: "a", bundleItems: [{ catalogEntryId: "bundle:b", optional: false, installOrder: 1 }] }
    const bundleB: CatalogEntry = { ...bundleEntry, id: "bundle:b", name: "b", bundleItems: [{ catalogEntryId: "bundle:a", optional: false, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [bundleA, bundleB] })
    const r = await installCatalog({ catalogId: "bundle:a", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("dependency cycle refused")
  })

  test("bundle: missing item refused", async () => {
    const broken: CatalogEntry = { ...bundleEntry, id: "bundle:broken", bundleItems: [{ catalogEntryId: "skill:ghost", optional: false, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [broken] })
    const r = await installCatalog({ catalogId: "bundle:broken", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("bundle item not in verified catalog")
  })
})

// ── scope 独立管理(AC#3)+ 项目闭环 fail-closed(AC#4)─────────────────────────────────────────

describe("scope independence (AC#3) & project closure (AC#4)", () => {
  test("same skill in global + two projects: three independent records; per-scope ops don't leak", async () => {
    const projA = makeProject("proj-a")
    const projB = makeProject("proj-b")
    const { deps } = makeDeps()
    expect((await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)).ok).toBe(true)
    expect((await installCatalog({ catalogId: "skill:demo", scope: { scope: "project", projectDir: projA } }, deps)).ok).toBe(true)
    expect((await installCatalog({ catalogId: "skill:demo", scope: { scope: "project", projectDir: projB } }, deps)).ok).toBe(true)
    const rootA = path.join(projA, ".alpha")
    const rootB = path.join(projB, ".alpha")
    expect(findRecordV2(globalRoot, "skill", "demo")?.scope.kind).toBe("global")
    const recA = findRecordV2(rootA, "skill", "demo")
    expect(recA?.scope.kind).toBe("project")
    if (recA?.scope.kind === "project") expect(recA.scope.projectPath).toBe(projA)
    expect(findRecordV2(rootB, "skill", "demo")).not.toBeNull()

    // 禁用 A 项目的 → global 与 B 不动
    expect(setInstallStateByKey({ type: "skill", name: "demo", scope: "project", projectDir: projA, state: "disabled" }, { globalRoot: () => globalRoot }).ok).toBe(true)
    expect(findRecordV2(rootA, "skill", "demo")?.desiredState).toBe("disabled")
    expect(findRecordV2(globalRoot, "skill", "demo")?.desiredState).toBe("enabled")
    expect(findRecordV2(rootB, "skill", "demo")?.desiredState).toBe("enabled")

    // 卸载 B 项目的 → global 与 A 不动
    const un = await uninstallByKey({ type: "skill", name: "demo", scope: "project", projectDir: projB }, deps)
    expect(un.ok).toBe(true)
    expect(findRecordV2(rootB, "skill", "demo")).toBeNull()
    expect(findRecordV2(rootA, "skill", "demo")).not.toBeNull()
    expect(findRecordV2(globalRoot, "skill", "demo")).not.toBeNull()
  })

  test("moved project → uninstall REFUSES (fail closed), record intact, no fs removal, never global fallback", async () => {
    const projA = makeProject("proj-move")
    const { deps, calls } = makeDeps()
    await installCatalog({ catalogId: "skill:demo", scope: { scope: "project", projectDir: projA } }, deps)
    const projMoved = path.join(tmp, "proj-moved")
    fs.renameSync(projA, projMoved)
    calls.length = 0
    const r = await uninstallByKey({ type: "skill", name: "demo", scope: "project", projectDir: projMoved }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("identity mismatch")
      expect(r.reason).toContain("NOT falling back to global")
    }
    expect(called(calls, "removeFsInstall")).toHaveLength(0)
    expect(findRecordV2(path.join(projMoved, ".alpha"), "skill", "demo")).not.toBeNull()
    // 老路径已不存在 → 同样 fail closed
    const gone = await uninstallByKey({ type: "skill", name: "demo", scope: "project", projectDir: projA }, deps)
    expect(gone.ok).toBe(false)
  })

  test("set-state on moved project fails closed too", async () => {
    const projA = makeProject("proj-move-state")
    const { deps } = makeDeps()
    await installCatalog({ catalogId: "skill:demo", scope: { scope: "project", projectDir: projA } }, deps)
    const projMoved = path.join(tmp, "proj-moved-state")
    fs.renameSync(projA, projMoved)
    const r = setInstallStateByKey({ type: "skill", name: "demo", scope: "project", projectDir: projMoved, state: "disabled" }, { globalRoot: () => globalRoot })
    expect(r.ok).toBe(false)
    expect(findRecordV2(path.join(projMoved, ".alpha"), "skill", "demo")?.desiredState).toBe("enabled")
  })

  test("project-scoped record reached via global intent → fail closed", async () => {
    const proj = makeProject("proj-x")
    // 人为把 project-identity record 放进 global 账本(损坏/搬运场景)
    const identityRecord: UpsertInput = {
      id: "skill:demo",
      name: "demo",
      kind: "skill",
      environment: "prod",
      scope: { kind: "project", projectPath: proj, projectPathHash: "d".repeat(64) },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, identityRecord).ok).toBe(true)
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("record is project-scoped but intent is global")
    expect(called(calls, "removeFsInstall")).toHaveLength(0)
  })
})

// ── uninstall:main 从自己账本读事实,owned paths 重新派生 ───────────────────────────────────────

describe("uninstall — facts from main's own ledger", () => {
  test("not installed → refuse (renderer cannot conjure a receipt)", async () => {
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "never-installed", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not installed")
    expect(installerCallCount(calls)).toBe(0)
  })

  test("mcp uninstall: secrets revoked + config removed + record dropped", async () => {
    const { deps, calls } = makeDeps()
    await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    calls.length = 0
    const r = await uninstallByKey({ type: "mcp", name: "markitdown", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "removeMcpSecrets")).toHaveLength(1)
    expect(called(calls, "removeMcp")).toHaveLength(1)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
  })

  test("vendored plugin: ledger path outside derived root → fail closed", async () => {
    const rogue: UpsertInput = {
      id: "plugin:vp",
      name: "vp",
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      configKey: "plugin-path:/evil/elsewhere/plugin.js",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, rogue).ok).toBe(true)
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "plugin", name: "vp", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("does not match derived")
    expect(called(calls, "removePluginPath")).toHaveLength(0)
  })

  test("vendored plugin: matching derived path → removed via re-derived owned path", async () => {
    const { deps, calls } = makeDeps()
    await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    calls.length = 0
    const r = await uninstallByKey({ type: "plugin", name: "vp", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    const rm = called(calls, "removePluginPath")
    expect(rm).toHaveLength(1)
    expect(rm[0]!.args[1]).toBe(path.join(globalRoot, "plugins", "vp", "plugin.js"))
    expect(findRecordV2(globalRoot, "plugin", "vp")).toBeNull()
  })

  test("v1-only receipt (no v2 record) remains uninstallable — read-only compat (AC#6)", async () => {
    // v1 存量:直接落一张 v1 receipt(无 record)
    addReceipt(globalRoot, {
      id: "user:oldskill",
      name: "oldskill",
      type: "skill",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "created",
    })
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "oldskill", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "removeFsInstall")).toHaveLength(1)
  })

  // REQ-099 #256:损坏 v2 record 绝不静默回退同账本 v1 receipt 继续卸载。
  test("corrupt v2 record for the target key blocks v1 fallback (fail closed)", async () => {
    // 同 key 既有一张 v1 receipt,又有一条损坏的 v2 record(kind/name 可归属但 schema 非法)。
    addReceipt(globalRoot, {
      id: "user:dualskill",
      name: "dualskill",
      type: "skill",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "created",
    })
    const ledger = path.join(globalRoot, "installs.json")
    const raw = JSON.parse(fs.readFileSync(ledger, "utf8"))
    raw.records = [{ schemaVersion: 999, kind: "skill", name: "dualskill" }] // 版本不支持 = 损坏,但 kind:name 可提取
    fs.writeFileSync(ledger, JSON.stringify(raw))
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "dualskill", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("fail closed")
    expect(called(calls, "removeFsInstall")).toHaveLength(0) // 绝不按 v1 字段删文件
  })

  test("unattributable corrupt v2 record blocks ALL v1 fallback in that ledger (fail closed)", async () => {
    addReceipt(globalRoot, {
      id: "user:otherskill",
      name: "otherskill",
      type: "skill",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "created",
    })
    const ledger = path.join(globalRoot, "installs.json")
    const raw = JSON.parse(fs.readFileSync(ledger, "utf8"))
    raw.records = [{ schemaVersion: 999, junk: true }] // 连 kind/name 都提不出 = 不可归属
    fs.writeFileSync(ledger, JSON.stringify(raw))
    const { deps, calls } = makeDeps()
    // 目标是另一个 key,但账本存在不可归属损坏项 → 无法证明目标不是它 → 拒绝
    const r = await uninstallByKey({ type: "skill", name: "otherskill", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("fail closed")
    expect(called(calls, "removeFsInstall")).toHaveLength(0)
  })

  test("transaction hooks: begin/commit on success", async () => {
    const txEvents: string[] = []
    const tx: InstallTransactionHooks = {
      begin: (plan) => {
        txEvents.push(`begin:${plan.op}`)
        return { txId: "t" }
      },
      commit: () => void txEvents.push("commit"),
      rollback: (_, reason) => void txEvents.push(`rollback:${reason}`),
    }
    const { deps } = makeDeps({ transaction: tx })
    await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    await uninstallByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    expect(txEvents).toEqual(["begin:install", "commit", "begin:uninstall", "commit"])
  })
})

// ── deriveMcpConfig 独立面(补充边界)───────────────────────────────────────────────────────────

describe("deriveMcpConfig — boundary cases", () => {
  test("empty command / missing url refused", () => {
    expect(deriveMcpConfig({ kind: "mcp", mcpType: "local" }, {}).ok).toBe(false)
    expect(deriveMcpConfig({ kind: "mcp", mcpType: "remote" }, {}).ok).toBe(false)
  })
  test("only non-empty secret values are reported as secretVars(空值不 fileify)", () => {
    const r = deriveMcpConfig({ kind: "mcp", mcpType: "local", command: ["x"], requiredEnvVars: ["A", "B"] }, { secrets: { A: "v", B: "" } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.secretVars).toEqual(["A"])
  })
})
