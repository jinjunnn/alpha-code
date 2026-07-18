// REQ-099(issue #191 / ADR-028 §1/§2/§5)—— main-only 安装计划单测:
//  · AC#2 伪造 renderer 事实(server config/包名/路径/整张 receipt)没有通道 —— 未知意图键 loud 拒绝,
//    安装事实全部从已验 catalog 重新派生;
//  · AC#1 合成 manifest 写盘前严格校验(非法 manifest / 平台不兼容 / 循环依赖在任何 installer 调用之前拒绝);
//  · AC#3 global 与多项目同名安装互不影响(账本物理分域 + scope identity);
//  · AC#4 项目移动 / identity 不符 fail closed,绝不退化为 global 卸载;
//  · REQ-100 事务接缝(begin/commit/rollback)与孤儿密钥回收。
// 依赖注入假 installer(仓规:零 mock.module);账本走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { curationBlobUrl } from "../shared/catalog-curation"
import { addReceipt } from "./alpha-installs"
import { aggregateFilesDigest, computeManifestDigest, decodeManifestV2 } from "./ext-manifest-v2"
import { hasCasBlob } from "./ext-cas"
import { computeGrantDigest, findRecordV2, projectScopeIdentity, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"
import { readCapabilityGrant, writeCapabilityGrantSync } from "./ext-capability-grants"
import { setDesiredStateV2, upsertRecordsV2 } from "./ext-receipt-v2"
import { probeTransactionJournals, resolveLiveGenerationDir } from "./ext-transaction"
import { skillStorePaths } from "./ext-skill-generations"
import { tryAcquireBundleLock } from "./ext-bundle-lock"

// #348:capability→authorize 闸生效后,首装会零副作用停在 stage="authorize"。本 helper 按生产
// 同路重驱(确认展示的完整 requested 集);非 authorize 失败原样透传,不掩盖任何拒绝语义。
// 需要断言首驱行为(authorize 暂停本身/attempt 生命周期)的测试直接调 installCatalog。
async function installAuthorized(intent: unknown, deps: Parameters<typeof installCatalog>[1]): ReturnType<typeof installCatalog> {
  const first = await installCatalog(intent, deps)
  if (first.ok || first.stage !== "authorize") return first
  const confirmed = Object.fromEntries(
    first.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]),
  )
  return installCatalog({ ...(intent as Record<string, unknown>), authorization: { confirmed } }, deps)
}
import {
  cloudDesiredStateGate,
  decodeCatalogInstallIntent,
  decodeSetStateIntent,
  decodeUninstallIntent,
  deriveMcpConfig,
  installCatalog,
  listGenerationsByKey,
  PROJECT_INSTALL_UNSUPPORTED_REASON,
  rollbackGenerationByKey,
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

// #395:机器面测试用第一方 source(alpha)保持 enabled 投影(默认关策略另有专项测试)。
const base = { displayName: "d", description: "d", source: "alpha" as const, category: "test" }

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
// REQ-098 #303:清单 digest/bytes 必须与下载 stub 的真实内容一致(promote 前结构校验 + CAS put 再验)。
const REMOTE_SKILL_MD = "---\nname: remote-demo\ndescription: test\n---\nbody"
const remoteFiles = [
  {
    path: "SKILL.md",
    sha256: crypto.createHash("sha256").update(REMOTE_SKILL_MD).digest("hex"),
    bytes: Buffer.byteLength(REMOTE_SKILL_MD),
    url: "https://assets.example/SKILL.md",
  },
]
const skillRemoteEntry: CatalogEntry = {
  id: "skill:remote-demo",
  type: "skill",
  name: "remote-demo",
  ...base,
  version: "1.2.0",
  installSpec: { kind: "skill", source: "remote", targetDir: "alpha-skills" },
  remoteAsset: { version: "1.2.0", files: remoteFiles },
}
// #361:catalog agent 走事务载体(builtin 载荷由 collectBuiltinAgentPayload 收集;remote 与
// skill 同款清单钉死)。内容必须 agentMdToEntry 可解析(description + body)。
const AGENT_MD = "---\ndescription: test agent\n---\nagent body"
const REMOTE_AGENT_MD = "---\ndescription: remote test agent\n---\nremote agent body"
const agentRemoteFiles = [
  {
    path: "remote-agent.md",
    sha256: crypto.createHash("sha256").update(REMOTE_AGENT_MD).digest("hex"),
    bytes: Buffer.byteLength(REMOTE_AGENT_MD),
    url: "https://assets.example/remote-agent.md",
  },
]
const agentBuiltinEntry: CatalogEntry = {
  id: "agent:helper",
  type: "agent",
  name: "helper",
  ...base,
  version: "1.0.0",
  installSpec: { kind: "agent", source: "builtin", builtinAssetKey: "agents/helper.md" },
} as CatalogEntry
const agentRemoteEntry: CatalogEntry = {
  id: "agent:remote-agent",
  type: "agent",
  name: "remote-agent",
  ...base,
  version: "1.1.0",
  installSpec: { kind: "agent", source: "remote" },
  remoteAsset: { version: "1.1.0", files: agentRemoteFiles },
} as CatalogEntry
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
    // #378:策略闸口(缺省透传 ok;Excel 策略语义在专项测试注入)+ 版本化密钥原语(真写 tmp
    // 密钥目录,引用与落盘同参 —— live 回填/GC 断言拿真实路径)。
    applyMcpWritePolicy: (name: string, server: Record<string, unknown>) => {
      calls.push({ fn: "applyMcpWritePolicy", args: [name, server] })
      return { ok: true as const }
    },
    mcpSecretRefFor: (name: string, verId: string, varName: string) => `{file:${path.join(tmp, "mcp-secrets", name, verId, varName)}}`,
    claimMcpSecretVersionDir: (name: string, verId: string) => {
      calls.push({ fn: "claimMcpSecretVersionDir", args: [name, verId] })
      const dir = path.join(tmp, "mcp-secrets", name, verId)
      if (fs.existsSync(dir)) return { ok: false as const, exists: true, reason: "exists" }
      fs.mkdirSync(dir, { recursive: true })
      return { ok: true as const }
    },
    writeMcpSecretVersioned: (name: string, verId: string, varName: string, value: string) => {
      calls.push({ fn: "writeMcpSecretVersioned", args: [name, verId, varName, value] })
      const dir = path.join(tmp, "mcp-secrets", name, verId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, varName), value)
      return { ok: true as const, ref: `{file:${path.join(dir, varName)}}` }
    },
    removeMcpSecretVersionDir: (name: string, verId: string) => {
      calls.push({ fn: "removeMcpSecretVersionDir", args: [name, verId] })
      fs.rmSync(path.join(tmp, "mcp-secrets", name, verId), { recursive: true, force: true })
      return { ok: true as const }
    },
    gcMcpSecrets: (name: string) => {
      calls.push({ fn: "gcMcpSecrets", args: [name] })
      return { removed: [], warnings: [] }
    },
    legacyMcpRefPaths: (name: string) => {
      calls.push({ fn: "legacyMcpRefPaths", args: [name] })
      return { ok: true as const, refs: [] as string[] }
    },
    // #354:提交面 fail-closed 的前像原语(缺省 = 无前像、agent 不在场)。
    readMcpLeafStrict: (name: string) => {
      calls.push({ fn: "readMcpLeafStrict", args: [name] })
      return { ok: true as const, value: undefined }
    },
    // #378 r6/r7:legacy 源 strict 读(缺省零源;legacy 冲突语义在专项测试注入)+ 真源路由门。
    readLegacyPluginArrayStrict: () => {
      calls.push({ fn: "readLegacyPluginArrayStrict", args: [] })
      return { ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }
    },
    mcpConfigTruthPath: () => path.join(globalRoot, "alpha.jsonc"),
    // #378(裁决 Q5):跨源同 base 检查 —— 镜像真实 alpha.jsonc 的 plugin[](legacy 缺省无冲突)。
    findPluginBaseConflictStrict: (pkg: string) => {
      calls.push({ fn: "findPluginBaseConflictStrict", args: [pkg] })
      const base = pkg.lastIndexOf("@") > 0 ? pkg.slice(0, pkg.lastIndexOf("@")) : pkg
      try {
        const t = path.join(globalRoot, "alpha.jsonc")
        if (!fs.existsSync(t)) return { ok: true as const, existing: undefined }
        const parsed = JSON.parse(fs.readFileSync(t, "utf8")) as { plugin?: unknown }
        const list = Array.isArray(parsed.plugin) ? parsed.plugin : []
        for (const p of list) {
          if (typeof p === "string" && (p.lastIndexOf("@") > 0 ? p.slice(0, p.lastIndexOf("@")) : p) === base)
            return { ok: true as const, existing: { spec: p, source: "main" as const } }
        }
        return { ok: true as const, existing: undefined }
      } catch {
        return { ok: false as const, reason: "config unreadable" }
      }
    },
    // #352:strict 数组读镜像测试真实 alpha.jsonc(引擎 config action 写同一文件,plan/precondition 同源)。
    readPluginArrayStrict: () => {
      try {
        const t = path.join(globalRoot, "alpha.jsonc")
        if (!fs.existsSync(t)) return { ok: true as const, value: [] as unknown[] }
        const parsed = JSON.parse(fs.readFileSync(t, "utf8")) as { plugin?: unknown }
        return { ok: true as const, value: Array.isArray(parsed.plugin) ? parsed.plugin : [] }
      } catch {
        return { ok: false as const, reason: "config unreadable" }
      }
    },
    stageVendoredPluginVersioned: (key: string, name: string) => {
      calls.push({ fn: "stageVendoredPluginVersioned", args: [key, name] })
      const dir = path.join(globalRoot, "plugins", `${name}@feed1234`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "plugin.js"), "// staged")
      return { ok: true as const, dir, jsPath: path.join(dir, "plugin.js") }
    },
    agentPresent: (name: string) => {
      calls.push({ fn: "agentPresent", args: [name] })
      return false
    },
    removeMcpConfigInLock: record("removeMcpConfigInLock", { ok: true as const }),
    removeMcpSecretsStrict: record("removeMcpSecretsStrict", { ok: true as const }),
    removePlugin: record("removePlugin", { ok: true as const }),
    // #378:vendored 载荷采集(CAS 摄取源;真 plugin.js 字节供引擎 file items 全链)。
    collectVendoredPluginPayload: (key: string, name: string) => {
      calls.push({ fn: "collectVendoredPluginPayload", args: [key, name] })
      return { ok: true as const, files: [{ path: "plugin.js", data: Buffer.from(`// vendored ${name} (${key})`) }] }
    },
    removePluginPath: record("removePluginPath", { ok: true as const }),
    installBuiltinSkill: record("installBuiltinSkill", { ok: true as const, files: ["/derived/skill"] }),
    collectBuiltinSkillPayload: (key: string, name: string) => {
      calls.push({ fn: "collectBuiltinSkillPayload", args: [key, name] })
      // 有效 frontmatter(name 匹配 + description)= 类型化 probe(#312)通过。
      return { ok: true as const, files: [{ path: "SKILL.md", data: Buffer.from(`---\nname: ${name}\ndescription: test ${name}\n---\nbody`) }] }
    },
    // #361:builtin agent 载荷收集(只读零副作用;内容 agentMdToEntry 可解析供真引擎走全链)。
    collectBuiltinAgentPayload: (key: string, name: string) => {
      calls.push({ fn: "collectBuiltinAgentPayload", args: [key, name] })
      return { ok: true as const, files: [{ path: `${name}.md`, data: Buffer.from(AGENT_MD) }] }
    },
    installRemoteSkill: record("installRemoteSkill", { ok: true as const, files: ["/derived/remote-skill"] }),
    removeFsInstall: record("removeFsInstall", { ok: true as const, files: [] }),
    downloadRemoteAsset: async (files) => {
      calls.push({ fn: "downloadRemoteAsset", args: [files] })
      // 内容与清单 digest/bytes 一致(#303 promote 前结构校验);skill/agent fixture 按清单路径分发。
      if (files[0]?.path === "remote-agent.md") return { ok: true, contents: [{ path: "remote-agent.md", data: Buffer.from(REMOTE_AGENT_MD) }] }
      return { ok: true, contents: [{ path: "SKILL.md", data: Buffer.from(REMOTE_SKILL_MD) }] }
    },
    ...opts.installers,
  }
  const entries = opts.entries ?? ALL_ENTRIES
  const deps: PlannerDeps = {
    advisoryGate: () => ({ allowed: true }), // #315:harness 缺省放行;闸语义在专项测试注入
    resolveEntry: async (catalogId) => {
      const entry = entries.find((e) => e.id === catalogId)
      return entry ? { entry, channel: "remote", catalogVersion: "2026-07-13.1" } : null
    },
    environment: () => "prod",
    platform: () => opts.platform ?? "darwin",
    globalRoot: () => globalRoot,
    // REQ-098 #303:共享 CAS 基根(≠ 环境根)—— 测试断言 blob 落这里而非 globalRoot。
    casBaseRoot: () => path.join(tmp, "cas-base"),
    installers,
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  }
  return { deps, calls }
}

const called = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn)

// #361:零断言读 alpha.jsonc 的 agent.<name> 叶(JSON.parse 结果走谓词收窄,不 cast)。
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
// #378:零断言读盘助手(oxlint no-unsafe-type-assertion Δ=0)。
const readCfgRoot = (): Record<string, unknown> => {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
  return isRec(raw) ? raw : {}
}
const mcpLeafOnDisk = (name: string): Record<string, unknown> | undefined => {
  const m = readCfgRoot().mcp
  if (!isRec(m)) return undefined
  const leaf = m[name]
  return isRec(leaf) ? leaf : undefined
}
const pluginArrayOnDisk = (): unknown[] => {
  const p = readCfgRoot().plugin
  return Array.isArray(p) ? p : []
}
const recOf = (v: unknown): Record<string, unknown> => (isRec(v) ? v : {})
const strOf = (v: unknown): string => (typeof v === "string" ? v : "")
const readAgentLeaf = (rootDir: string, name: string): Record<string, unknown> | undefined => {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, "alpha.jsonc"), "utf8"))
  if (!isRec(raw) || !isRec(raw.agent)) return undefined
  const leaf = raw.agent[name]
  return isRec(leaf) ? leaf : undefined
}
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
    // curated≠authored 的语义靠第三方 source 才能显形(#395 全局 fixture 改 alpha 后此处本地覆盖)。
    const verified: VerifiedCatalogEntry = { entry: { ...mcpEntry, source: "official" }, channel: "remote", catalogVersion: "2026-07-13.1" }
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
    const r = await installAuthorized({ catalogId: "mcp:bad", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing before any disk write")
    expect(installerCallCount(calls)).toBe(0)
    expect(fs.existsSync(path.join(globalRoot, "installs.json"))).toBe(false)
  })

  test("platform incompatibility refused before any installer call", async () => {
    const { deps, calls } = makeDeps({ platform: "linux" })
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("platform linux not supported")
    expect(installerCallCount(calls)).toBe(0)
  })

  test("entry not in verified catalog refused; zero side effects", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:ghost", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not in verified catalog")
    expect(installerCallCount(calls)).toBe(0)
  })
})

// ── MCP:grants 校验 + main 重建配置 ────────────────────────────────────────────────────────────

describe("MCP install — #395 默认关(第三方 source)", () => {
  test("Codex r8 M4:official source MCP 默认关 —— 落 enabled:false + 不发 liveMcp + 标 installedDisabled", async () => {
    const officialMcp: CatalogEntry = { ...mcpEntry, source: "official" }
    const { deps } = makeDeps({ entries: [officialMcp] })
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "s" } } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("mcp")
    expect(r.installedDisabled).toBe(true) // renderer 据此报「已装未启用」而非 kind 漂移失败
    expect(r.liveMcp).toBeUndefined() // 装 ≠ 连
    expect(mcpLeafOnDisk("markitdown")?.enabled).toBe(false) // 引擎消费键落盘
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
  })
})

describe("MCP install — facts re-derived from catalog, grants validated", () => {
  test("happy path(#378):config leaf 由引擎 config action 落盘;密钥走版本化 {file:} 通道;record 由 commitReceipt 落账", async () => {
    const { deps, calls } = makeDeps()
    const grants = { secrets: { API_KEY: "sekret-value" } }
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // live config(renderer 拿去 sdk.mcp.add)含密钥真值 —— 该值本就来自 renderer
    expect(r.liveMcp?.config).toEqual({ type: "local", command: ["uvx", "markitdown-mcp@0.0.1a4"], environment: { API_KEY: "sekret-value" } })
    // durable leaf 真实落盘(引擎 config action;名字来自 catalog):密钥 = 版本化引用,零明文
    const leaf = mcpLeafOnDisk("markitdown")
    expect(leaf?.command).toEqual(["uvx", "markitdown-mcp@0.0.1a4"])
    expect(strOf(recOf(leaf?.environment).API_KEY)).toMatch(/^\{file:.+API_KEY\}$/)
    expect(JSON.stringify(leaf)).not.toContain("sekret-value")
    // 版本化写(installAuthorized 两驱各一次;首驱 authorize 暂停即清);真值只进密钥文件;
    // 策略闸口每驱过;GC 只在提交成功后恰一次。
    const writes = called(calls, "writeMcpSecretVersioned")
    expect(writes).toHaveLength(2)
    expect(writes[0]!.args[0]).toBe("markitdown")
    expect(writes[0]!.args[3]).toBe("sekret-value")
    expect(called(calls, "removeMcpSecretVersionDir")).toHaveLength(1)
    expect(called(calls, "applyMcpWritePolicy")).toHaveLength(2)
    expect(called(calls, "gcMcpSecrets")).toHaveLength(1)
    // v2 record:environment/digests/desiredState/transaction 落账(引擎 commitReceipt 单点)
    const record = findRecordV2(globalRoot, "mcp", "markitdown")
    expect(record).not.toBeNull()
    expect(record!.environment).toBe("prod")
    expect(record!.origin).toBe("catalog")
    expect(record!.manifestDigest).toBe(r.manifestDigest!)
    expect(record!.grantDigest).toBe(computeGrantDigest(grants))
    expect(record!.generation).toBe(1)
    expect(record!.transaction?.state).toBe("committed")
  })

  test("REQ-099 #305 + #378:liveMcp = 策略后派生 —— 含 main 策略注入字段,{file:} 引用换回密钥真值", async () => {
    const { deps } = makeDeps({
      installers: {
        // 模拟策略闸口:main 策略原地注入受管字段(如 Excel EXCEL_FILES_PATH)
        applyMcpWritePolicy: (_name, config) => {
          const c = config as { environment?: Record<string, unknown> }
          c.environment = { ...(c.environment ?? {}), MANAGED_ROOT: "/managed/root" }
          return { ok: true as const }
        },
      },
    })
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "sekret-value" } } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const env = recOf(r.liveMcp?.config.environment)
    expect(env.MANAGED_ROOT).toBe("/managed/root") // 策略字段进 live(早克隆会漏)
    expect(env.API_KEY).toBe("sekret-value") // {file:} 引用换回 renderer 交来的真值
    // durable leaf 同样带策略字段 + 引用(live 从策略后 durable 派生)
    const durableEnv = recOf(mcpLeafOnDisk("markitdown")?.environment)
    expect(durableEnv.MANAGED_ROOT).toBe("/managed/root")
    expect(strOf(durableEnv.API_KEY)).toMatch(/^\{file:/)
  })

  test("REQ-099 #305(阻断项回归锁)+ #378:remote MCP header 密钥走版本化 {file:} 通道 —— durable 无明文,live 带真值", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:linear", scope: { scope: "global" }, grants: { secrets: { API_KEY: "sekret-value" } } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const durable = mcpLeafOnDisk("linear")
    const durableAuth = strOf(recOf(durable?.headers).Authorization)
    expect(durableAuth).toMatch(/^Bearer \{file:.+API_KEY\}$/) // 引用,非明文
    expect(JSON.stringify(durable)).not.toContain("sekret-value")
    expect(recOf(r.liveMcp?.config.headers).Authorization).toBe("Bearer sekret-value") // live 真值(renderer 拿去 mcp.add)
    const refPath = durableAuth.replace(/^Bearer \{file:/, "").replace(/\}$/, "")
    expect(fs.readFileSync(refPath, "utf8")).toBe("sekret-value") // 密钥文件落位(版本化路径)
  })

  test("REQ-099 #305 + #378:granted 密钥未落到任何字段(skipped)→ 拒绝,零写盘零版本目录", async () => {
    // remote 型 + 模板未引用的已声明变量 = granted 但落不到任何 config 字段(纯替换 skipped)。
    const orphanEntry = {
      ...mcpRemoteEntry,
      id: "mcp:orphan",
      name: "orphan",
      installSpec: { kind: "mcp", mcpType: "remote", url: "https://mcp.example.com/sse", requiredEnvVars: ["API_KEY", "UNUSED"], headersTemplate: { Authorization: "Bearer {API_KEY}" } },
    } as CatalogEntry
    const { deps, calls } = makeDeps({ entries: [...ALL_ENTRIES, orphanEntry] })
    const r = await installAuthorized({ catalogId: "mcp:orphan", scope: { scope: "global" }, grants: { secrets: { API_KEY: "used-key-value", UNUSED: "never-lands-anywhere" } } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing plaintext persist")
    expect(called(calls, "writeMcpSecretVersioned")).toHaveLength(0) // 拒绝先于任何落盘
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
  })

  test("REQ-100 #342(#351 回归锁)+ #378 Q1:更新失败(事务在途 busy)不毁既有密钥 —— 版本化只增,新版本目录清理,旧引用原样", async () => {
    const { deps, calls } = makeDeps()
    const first = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "old-value" } } }, deps)
    expect(first.ok).toBe(true)
    const cfgBefore = fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")
    const refBefore = strOf(recOf(mcpLeafOnDisk("markitdown")?.environment).API_KEY)
    const oldSecretPath = refBefore.replace(/^\{file:/, "").replace(/\}$/, "")
    expect(fs.readFileSync(oldSecretPath, "utf8")).toBe("old-value")
    calls.length = 0
    const held = tryAcquireBundleLock(globalRoot, { txId: "test-busy" })
    expect(held.ok).toBe(true)
    try {
      const second = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "new-value" } } }, deps)
      expect(second.ok).toBe(false)
    } finally {
      if (held.ok) held.lock.release()
    }
    // 旧安装零接触:leaf 原样、旧密钥文件原值;本次版本目录已清(无引用惰性)
    expect(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")).toBe(cfgBefore)
    expect(fs.readFileSync(oldSecretPath, "utf8")).toBe("old-value")
    expect(called(calls, "writeMcpSecretVersioned")).toHaveLength(1) // 新版本写过(独立目录)
    const rm = called(calls, "removeMcpSecretVersionDir")
    expect(rm).toHaveLength(1)
    expect(fs.existsSync(path.join(tmp, "mcp-secrets", "markitdown", strOf(rm[0]!.args[1])))).toBe(false)
  })

  test("#346 卸载顺序回归:config 删除失败 → 不吊销密钥(不留「配置在、密钥毁」半拆态)", async () => {
    const { deps, calls } = makeDeps({ installers: { removeMcpConfigInLock: () => ({ ok: false as const, reason: "config busy" }) } })
    const inst = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "v" } } }, deps)
    expect(inst.ok).toBe(true)
    calls.length = 0
    const u = await uninstallByKey({ type: "mcp", name: "markitdown", scope: "global" }, deps)
    expect(u.ok).toBe(false)
    expect(called(calls, "removeMcpSecretsStrict")).toHaveLength(0)
  })

  test("REQ-099 #305(高危回归锁):grant 值含 {file:}/{env:} 替换语法 → 派生前拒绝", async () => {
    const { deps, calls } = makeDeps()
    const viaFile = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "{file:/etc/passwd}" } } }, deps)
    expect(viaFile.ok).toBe(false)
    if (!viaFile.ok) expect(viaFile.reason).toContain("substitution syntax")
    const viaEnv = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { env: { API_KEY: "x{env:AWS_SECRET_ACCESS_KEY}y" } } }, deps)
    expect(viaEnv.ok).toBe(false)
    if (!viaEnv.ok) expect(viaEnv.reason).toContain("substitution syntax")
    expect(installerCallCount(calls)).toBe(0)
  })

  test("grant not declared by catalog entry (requiredEnvVars) refused before installers", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { EVIL_VAR: "x" } } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('grant "EVIL_VAR" not declared')
    expect(called(calls, "persistMcp")).toHaveLength(0)
    expect(called(calls, "fileifyMcpSecrets")).toHaveLength(0)
  })

  test("workspace grant: required when declared, refused when not declared", async () => {
    const { deps } = makeDeps()
    const missing = await installAuthorized({ catalogId: "mcp:excel", scope: { scope: "global" } }, deps)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain("workspace grant required")
    const undeclared = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { workspace: "/ws" } }, deps)
    expect(undeclared.ok).toBe(false)
    const { deps: deps2 } = makeDeps()
    const ok = await installAuthorized({ catalogId: "mcp:excel", scope: { scope: "global" }, grants: { workspace: "/ws/excel" } }, deps2)
    expect(ok.ok).toBe(true)
    expect(mcpLeafOnDisk("excel-mcp")?.command).toEqual(["uvx", "excel-mcp-server@0.1.8", "/ws/excel"])
  })

  test("remote MCP: url from catalog, headers from template + granted secret", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:linear", scope: { scope: "global" }, grants: { secrets: { API_KEY: "tok" } } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.liveMcp?.config).toEqual({ type: "remote", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer tok" } })
  })

  test("cnMirror env values are main-side constants (renderer only expresses the preference)", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:excel", scope: { scope: "global" }, grants: { workspace: "/ws", cnMirror: true } }, deps)
    expect(r.ok).toBe(true)
    const env = recOf(mcpLeafOnDisk("excel-mcp")?.environment)
    expect(env.npm_config_registry).toBe("https://registry.npmmirror.com")
    expect(strOf(env.PIP_INDEX_URL)).toContain("tuna.tsinghua.edu.cn")
  })

  test("引擎失败(#378)→ 外层通知钩子 rollback 配对 begin;本次密钥版本目录清理;零账本", async () => {
    const txEvents: string[] = []
    const tx: InstallTransactionHooks = {
      begin: (plan) => {
        txEvents.push(`begin:${plan.op}:${plan.name}`)
        return { txId: "tx-1" }
      },
      commit: (id) => void txEvents.push(`commit:${id}`),
      rollback: (id, reason) => void txEvents.push(`rollback:${id}:${reason}`),
    }
    const { deps, calls } = makeDeps({ transaction: tx })
    const held = tryAcquireBundleLock(globalRoot, { txId: "test-busy" })
    expect(held.ok).toBe(true)
    try {
      const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "v" } } }, deps)
      expect(r.ok).toBe(false)
    } finally {
      if (held.ok) held.lock.release()
    }
    expect(txEvents[0]).toBe("begin:install:markitdown")
    expect(txEvents[1]!.startsWith("rollback:tx-1:")).toBe(true)
    expect(called(calls, "removeMcpSecretVersionDir")).toHaveLength(1)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
  })

  test("mcp cannot be project-scoped (ADR-030 recall guard fires first)", async () => {
    const proj = makeProject("proj-mcp")
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "project", projectDir: proj } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(PROJECT_INSTALL_UNSUPPORTED_REASON)
    expect(installerCallCount(calls)).toBe(0)
  })
})

// ── skill / plugin / cloud / bundle ─────────────────────────────────────────────────────────────

describe("other kinds — derivation & records", () => {
  test("remote skill: download → 不可变 generation 事务;payloadDigest recorded(REQ-100 #310)", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "skill:remote-demo", scope: { scope: "global" } }, deps)
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

  // ── REQ-098 #303:catalog skill 内容一律经验证共享 CAS ────────────────────────────────────────
  test("#303 remote skill: blobs land in the shared CAS base (not the env root); generation matches", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "skill:remote-demo", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    const digest = remoteFiles[0]!.sha256
    expect(hasCasBlob(path.join(tmp, "cas-base"), digest)).toBe(true) // 共享 CAS 基根
    expect(hasCasBlob(globalRoot, digest)).toBe(false) // 不落环境根
    const live = resolveLiveGenerationDir(globalRoot, "skill--remote-demo")!
    expect(fs.readFileSync(path.join(live, "SKILL.md"), "utf8")).toBe(REMOTE_SKILL_MD)
  })

  test("#303 builtin skill: content-addressed into CAS; self-computed payloadDigest recorded", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    const body = "---\nname: demo\ndescription: test demo\n---\nbody"
    const digest = crypto.createHash("sha256").update(body).digest("hex")
    expect(hasCasBlob(path.join(tmp, "cas-base"), digest)).toBe(true)
    const record = findRecordV2(globalRoot, "skill", "demo")
    expect(record?.payloadDigest).toBe(aggregateFilesDigest([{ path: "SKILL.md", sha256: digest }]))
  })

  test("#303 refuses payload/manifest drift before any CAS write (extra/missing/renamed/size/digest)", async () => {
    const contents = (files: Array<{ path: string; data: string }>) => async () => ({
      ok: true as const,
      contents: files.map((f) => ({ path: f.path, data: Buffer.from(f.data) })),
    })
    const variants: Array<{ label: string; dl: ReturnType<typeof contents>; expects: string }> = [
      { label: "extra file", dl: contents([{ path: "SKILL.md", data: REMOTE_SKILL_MD }, { path: "sneak.md", data: "x" }]), expects: "file count mismatch" },
      { label: "missing file", dl: contents([]), expects: "file count mismatch" },
      { label: "renamed path", dl: contents([{ path: "OTHER.md", data: REMOTE_SKILL_MD }]), expects: "not in manifest" },
      { label: "size mismatch", dl: contents([{ path: "SKILL.md", data: REMOTE_SKILL_MD + "!" }]), expects: "size mismatch" },
      { label: "digest mismatch", dl: contents([{ path: "SKILL.md", data: "---\nname: remote-demo\ndescription: test\n---\nEVIL" }]), expects: "" },
    ]
    for (const v of variants) {
      const { deps } = makeDeps({ installers: { downloadRemoteAsset: v.dl } })
      const r = await installAuthorized({ catalogId: "skill:remote-demo", scope: { scope: "global" } }, deps)
      expect(r.ok).toBe(false)
      if (!r.ok && v.expects) expect(r.reason).toContain(v.expects)
      expect(findRecordV2(globalRoot, "skill", "remote-demo")).toBeNull()
      expect(resolveLiveGenerationDir(globalRoot, "skill--remote-demo")).toBeNull()
      // 严格两遍式:结构校验失败时 CAS 零写入(review #363 Minor 1)—— digest 变体除外
      //(它恰在 put 内被拒,合法文件先行 put 不适用:单文件清单)。
      if (v.label !== "digest mismatch") expect(hasCasBlob(path.join(tmp, "cas-base"), remoteFiles[0]!.sha256)).toBe(false)
    }
  })

  test("#303 refuses manifests colliding under case/unicode folding and non-portable segments", async () => {
    const twoFile = (files: Array<{ path: string; data: string }>): CatalogEntry => ({
      ...skillRemoteEntry,
      id: "skill:fold",
      name: "fold",
      remoteAsset: {
        version: "1.2.0",
        files: files.map((f) => ({ path: f.path, sha256: crypto.createHash("sha256").update(f.data).digest("hex"), bytes: Buffer.byteLength(f.data), url: `https://assets.example/${f.path}` })),
      },
    })
    const dlFor = (files: Array<{ path: string; data: string }>) => async () => ({ ok: true as const, contents: files.map((f) => ({ path: f.path, data: Buffer.from(f.data) })) })

    const folded = [{ path: "Docs/A.md", data: "one" }, { path: "docs/a.md", data: "two" }]
    const { deps: foldDeps } = makeDeps({ entries: [twoFile(folded)], installers: { downloadRemoteAsset: dlFor(folded) } })
    const rf = await installAuthorized({ catalogId: "skill:fold", scope: { scope: "global" } }, foldDeps)
    expect(rf.ok).toBe(false)
    if (!rf.ok) expect(rf.reason).toContain("collision under case/unicode folding")

    const reserved = [{ path: "CON.md", data: "x" }]
    const { deps: resDeps } = makeDeps({ entries: [twoFile(reserved)], installers: { downloadRemoteAsset: dlFor(reserved) } })
    const rr = await installAuthorized({ catalogId: "skill:fold", scope: { scope: "global" } }, resDeps)
    expect(rr.ok).toBe(false)
    if (!rr.ok) expect(rr.reason).toContain("reserved filename")

    const trailingDot = [{ path: "notes./SKILL.md", data: "x" }]
    const { deps: dotDeps } = makeDeps({ entries: [twoFile(trailingDot)], installers: { downloadRemoteAsset: dlFor(trailingDot) } })
    const rd = await installAuthorized({ catalogId: "skill:fold", scope: { scope: "global" } }, dotDeps)
    expect(rd.ok).toBe(false)
    if (!rd.ok) expect(rd.reason).toContain("trailing dot/space")
  })

  test("vendored plugin(#378):载荷经 CAS file items 事务落内容寻址目录;configKey/record 由 commitReceipt 落账", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(called(calls, "collectVendoredPluginPayload")[0]!.args).toEqual(["plugins/vp", "vp"])
    const record = findRecordV2(globalRoot, "plugin", "vp")
    expect(record).not.toBeNull()
    // 内容寻址目录 plugins/vp@<digest16>(#359 seed 同一载体);plugin.js 实物落位 + config 换元
    const dir = r.files?.[0]
    expect(dir).toMatch(/plugins\/vp@[0-9a-f]{16}$/)
    expect(fs.existsSync(path.join(dir!, "plugin.js"))).toBe(true)
    expect(record?.configKey).toBe(`plugin-path:${path.join(dir!, "plugin.js")}`)
    expect(pluginArrayOnDisk()).toEqual([path.join(dir!, "plugin.js")])
    expect(record?.transaction?.state).toBe("committed")
  })

  test("npm plugin(#378):config action 单事务整数组换元;跨源冲突双查", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(pluginArrayOnDisk()).toEqual(["@alpha/np@2.3.4"])
    // 计划前 + 锁内 precondition 双查(installAuthorized 两驱 → 首驱 1 次计划前,重驱 1 次计划前 + 1 次锁内)
    expect(called(calls, "findPluginBaseConflictStrict").length).toBeGreaterThanOrEqual(2)
    const record = findRecordV2(globalRoot, "plugin", "np")
    expect(record?.configKey).toBe("plugin:@alpha/np@2.3.4")
    expect(record?.transaction?.state).toBe("committed")
  })

  test("cloud: receipts-only — record written, zero installer calls", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(installerCallCount(calls)).toBe(0)
    expect(findRecordV2(globalRoot, "cloud", "research")).not.toBeNull()
  })

  test("bundle: required secret-MCP child → fail-closed(不在原子边界内,REQ-100 #311)", async () => {
    // bundle:office 的 mcp:markitdown 声明 requiredEnvVars → 首期不支持原子安装 → required 致命 → 整单拒绝。
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "bundle:office", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("required bundle child")
  })

  test("bundle: skill(generation)+ 无密钥 MCP(config)一次原子提交(REQ-100 #311)", async () => {
    const cleanMcp: CatalogEntry = { ...mcpEntry, id: "mcp:clean", name: "clean", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "clean-mcp@1.0.0"] } }
    const cleanBundle: CatalogEntry = { ...bundleEntry, id: "bundle:clean", name: "cleanb", bundleItems: [{ catalogEntryId: "skill:demo", optional: false, installOrder: 1 }, { catalogEntryId: "mcp:clean", optional: false, installOrder: 2 }] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, cleanMcp, cleanBundle] })
    const r = await installAuthorized({ catalogId: "bundle:clean", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.installed?.sort()).toEqual(["mcp:clean", "skill:demo"])
    expect(resolveLiveGenerationDir(globalRoot, "skill--demo")).not.toBeNull() // skill 进 generation
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    expect(cfg.mcp.clean).toEqual({ type: "local", command: ["uvx", "clean-mcp@1.0.0"] }) // MCP 进 config
    expect(findRecordV2(globalRoot, "skill", "demo")).not.toBeNull()
    expect(findRecordV2(globalRoot, "mcp", "clean")).not.toBeNull()
  })

  test("#303 bundle: skill child blobs go through shared CAS; populate materializes from CAS", async () => {
    const casBundle: CatalogEntry = { ...bundleEntry, id: "bundle:cas", name: "casb", bundleItems: [{ catalogEntryId: "skill:remote-demo", optional: false, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, casBundle] })
    const r = await installAuthorized({ catalogId: "bundle:cas", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(hasCasBlob(path.join(tmp, "cas-base"), remoteFiles[0]!.sha256)).toBe(true)
    const live = resolveLiveGenerationDir(globalRoot, "skill--remote-demo")!
    expect(fs.readFileSync(path.join(live, "SKILL.md"), "utf8")).toBe(REMOTE_SKILL_MD)
  })

  test("#303 bundle: required child CAS promotion failure refuses the whole bundle; optional → skipped", async () => {
    const badDl = async () => ({ ok: true as const, contents: [{ path: "SKILL.md", data: Buffer.from("---\nname: remote-demo\ndescription: test\n---\nEVIL") }] })
    const reqBundle: CatalogEntry = { ...bundleEntry, id: "bundle:req", name: "reqb", bundleItems: [{ catalogEntryId: "skill:remote-demo", optional: false, installOrder: 1 }] }
    const { deps: reqDeps } = makeDeps({ entries: [...ALL_ENTRIES, reqBundle], installers: { downloadRemoteAsset: badDl } })
    const rq = await installAuthorized({ catalogId: "bundle:req", scope: { scope: "global" } }, reqDeps)
    expect(rq.ok).toBe(false)
    if (!rq.ok) expect(rq.reason).toContain("required bundle child")

    const optBundle: CatalogEntry = { ...bundleEntry, id: "bundle:opt", name: "optb", bundleItems: [{ catalogEntryId: "skill:remote-demo", optional: true, installOrder: 1 }, { catalogEntryId: "cloud:research", optional: false, installOrder: 2 }] }
    const { deps: optDeps } = makeDeps({ entries: [...ALL_ENTRIES, optBundle], installers: { downloadRemoteAsset: badDl } })
    const ro = await installAuthorized({ catalogId: "bundle:opt", scope: { scope: "global" } }, optDeps)
    expect(ro.ok).toBe(true)
    if (!ro.ok) return
    expect(ro.installed).toEqual(["cloud:research"])
    expect(ro.skipped?.some((s) => s.id === "skill:remote-demo")).toBe(true)
  })

  test("#303 bundle: colliding skip ids no longer refuse the bundle (injective journal keys)", async () => {
    // 朴素 replace(":","--") 下这两个 id 会碰撞成同一 journal key → validatePlan 判 duplicate 拒整单。
    const ghostA: CatalogEntry = { ...skillBuiltinEntry, id: "skill:a:b--c", name: "ghost-a", installSpec: { kind: "skill", source: "remote", targetDir: "alpha-skills" } }
    const ghostB: CatalogEntry = { ...skillBuiltinEntry, id: "skill:a--b:c", name: "ghost-b", installSpec: { kind: "skill", source: "remote", targetDir: "alpha-skills" } }
    const collideBundle: CatalogEntry = { ...bundleEntry, id: "bundle:collide", name: "collideb", bundleItems: [
      { catalogEntryId: "skill:a:b--c", optional: true, installOrder: 1 },
      { catalogEntryId: "skill:a--b:c", optional: true, installOrder: 2 },
      { catalogEntryId: "cloud:research", optional: false, installOrder: 3 },
    ] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, ghostA, ghostB, collideBundle] })
    const r = await installAuthorized({ catalogId: "bundle:collide", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.installed).toEqual(["cloud:research"])
    expect(r.skipped?.map((s) => s.id).sort()).toEqual(["skill:a--b:c", "skill:a:b--c"])
  })

  test("#303 bundle: all-optional promotion failure → ok, nothing installed, no transaction/journal", async () => {
    const badDl = async () => ({ ok: true as const, contents: [{ path: "SKILL.md", data: Buffer.from("---\nname: remote-demo\ndescription: test\n---\nEVIL") }] })
    const allOpt: CatalogEntry = { ...bundleEntry, id: "bundle:allopt", name: "alloptb", bundleItems: [{ catalogEntryId: "skill:remote-demo", optional: true, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, allOpt], installers: { downloadRemoteAsset: badDl } })
    const r = await installAuthorized({ catalogId: "bundle:allopt", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.installed).toEqual([])
    expect(r.skipped?.some((s) => s.id === "skill:remote-demo")).toBe(true)
    // 零状态变更:不开事务(无 ext-tx 目录/journal),账本无记录。
    expect(fs.existsSync(path.join(globalRoot, "ext-tx"))).toBe(false)
    expect(findRecordV2(globalRoot, "skill", "remote-demo")).toBeNull()
  })

  test("bundle: 项目 scope 拒绝(ADR-030 统一合同;此前为 #311 单 root 原子性拒)", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "bundle:office", scope: { scope: "project", projectDir: "/tmp/proj" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(PROJECT_INSTALL_UNSUPPORTED_REASON)
  })

  test("bundle: dependency cycle refused at plan time (AC#1)", async () => {
    const bundleA: CatalogEntry = { ...bundleEntry, id: "bundle:a", name: "a", bundleItems: [{ catalogEntryId: "bundle:b", optional: false, installOrder: 1 }] }
    const bundleB: CatalogEntry = { ...bundleEntry, id: "bundle:b", name: "b", bundleItems: [{ catalogEntryId: "bundle:a", optional: false, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [bundleA, bundleB] })
    const r = await installAuthorized({ catalogId: "bundle:a", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("dependency cycle refused")
  })

  test("bundle: missing item refused", async () => {
    const broken: CatalogEntry = { ...bundleEntry, id: "bundle:broken", bundleItems: [{ catalogEntryId: "skill:ghost", optional: false, installOrder: 1 }] }
    const { deps } = makeDeps({ entries: [broken] })
    const r = await installAuthorized({ catalogId: "bundle:broken", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("bundle item not in verified catalog")
  })
})

// ── ADR-030(#372):新增 project 安装收回(fail-closed)+ 遗留管理面(AC#3/AC#4 语义保留)────────

/** 直接落一条 project catalog 残留账(模拟收回前的历史安装;identity 走真 projectScopeIdentity)。 */
function seedProjectCatalogRecord(projDir: string, name = "demo", kind: UpsertInput["kind"] = "skill"): string {
  const identity = projectScopeIdentity(projDir)
  if (!identity.ok) throw new Error(identity.reason)
  const root = path.join(identity.scope.projectPath, ".alpha")
  const w = upsertRecordV2(root, {
    id: `${kind}:${name}`,
    name,
    kind,
    environment: "prod",
    scope: identity.scope,
    desiredState: "enabled",
    origin: "catalog",
    installedAt: new Date().toISOString(),
  })
  if (!w.ok) throw new Error(w.reason)
  return root
}

describe("ADR-030 (#372): project catalog/seed install recalled — refused before any side effect", () => {
  test("skill/agent symmetric: refused with the stable reason before resolveEntry", async () => {
    const proj = makeProject("proj-recall")
    const { deps, calls } = makeDeps()
    let resolveCalls = 0
    const spied: PlannerDeps = { ...deps, resolveEntry: async (id) => (resolveCalls++, deps.resolveEntry(id)) }
    for (const catalogId of ["skill:demo", "agent:whatever", "skill:remote-demo"]) {
      const r = await installAuthorized({ catalogId, scope: { scope: "project", projectDir: proj } }, spied)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe(PROJECT_INSTALL_UNSUPPORTED_REASON)
    }
    expect(resolveCalls).toBe(0)
    expect(installerCallCount(calls)).toBe(0)
    // 零状态变更:项目根没有任何事务/账本落盘
    expect(fs.existsSync(path.join(proj, ".alpha"))).toBe(false)
  })

  test("seed intent with project scope: same stable refusal before the seed channel", async () => {
    const proj = makeProject("proj-seed-recall")
    const { deps, calls } = makeDeps()
    let seedTouched = 0
    const withSeed: PlannerDeps = {
      ...deps,
      seed: { seedDir: () => (seedTouched++, null), resolveBundledEntry: () => (seedTouched++, null) },
    }
    const r = await installAuthorized({ source: "seed", assetId: "skills/foo", scope: { scope: "project", projectDir: proj } }, withSeed)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(PROJECT_INSTALL_UNSUPPORTED_REASON)
    expect(seedTouched).toBe(0) // 拒绝先于 seed 通道的任何触碰
    expect(installerCallCount(calls)).toBe(0)
    expect(fs.existsSync(path.join(proj, ".alpha"))).toBe(false) // 零项目根变更
  })

  test("global install behavior unchanged by the guard", async () => {
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    expect(findRecordV2(globalRoot, "skill", "demo")?.scope.kind).toBe("global")
  })
})

describe("legacy project manage (AC#3/AC#4 semantics kept for residuals)", () => {
  test("residual records in global + two projects stay independently manageable", async () => {
    const projA = makeProject("proj-a")
    const projB = makeProject("proj-b")
    const { deps } = makeDeps()
    expect((await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)).ok).toBe(true)
    const rootA = seedProjectCatalogRecord(projA)
    const rootB = seedProjectCatalogRecord(projB)
    expect(findRecordV2(globalRoot, "skill", "demo")?.scope.kind).toBe("global")
    const recA = findRecordV2(rootA, "skill", "demo")
    expect(recA?.scope.kind).toBe("project")
    if (recA?.scope.kind === "project") expect(recA.scope.projectPath).toBe(projA)
    expect(findRecordV2(rootB, "skill", "demo")).not.toBeNull()

    // 禁用 A 项目的 → global 与 B 不动
    expect((await setInstallStateByKey({ type: "skill", name: "demo", scope: "project", projectDir: projA, state: "disabled" }, { globalRoot: () => globalRoot, advisoryGate: () => ({ allowed: true }), resolveEntry: async () => null })).ok).toBe(true)
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

  test("project skill residual WITH generation store → journaled store+ledger teardown, no flat removal (#372)", async () => {
    const projA = makeProject("proj-gen-residual")
    const rootA = seedProjectCatalogRecord(projA)
    const sp = skillStorePaths(rootA, "demo")
    const genDir = path.join(sp.generations, "gen-000001-abcdef12")
    fs.mkdirSync(genDir, { recursive: true })
    fs.writeFileSync(path.join(genDir, "SKILL.md"), "---\nname: demo\ndescription: t\n---\nbody")
    fs.writeFileSync(sp.pointer, JSON.stringify({ genId: "gen-000001-abcdef12" }))
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "demo", scope: "project", projectDir: projA }, deps)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(sp.store)).toBe(false) // 受控 ext-store 删除
    expect(findRecordV2(rootA, "skill", "demo")).toBeNull() // 账本删除
    expect(called(calls, "removeFsInstall")).toHaveLength(0) // 绝不落 flat 删除
  })

  test("moved project → uninstall REFUSES (fail closed), record intact, no fs removal, never global fallback", async () => {
    const projA = makeProject("proj-move")
    seedProjectCatalogRecord(projA)
    const { deps, calls } = makeDeps()
    const projMoved = path.join(tmp, "proj-moved")
    fs.renameSync(projA, projMoved)
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
    seedProjectCatalogRecord(projA)
    const projMoved = path.join(tmp, "proj-moved-state")
    fs.renameSync(projA, projMoved)
    const r = await setInstallStateByKey({ type: "skill", name: "demo", scope: "project", projectDir: projMoved, state: "disabled" }, { globalRoot: () => globalRoot, advisoryGate: () => ({ allowed: true }), resolveEntry: async () => null })
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
  test("REQ-100 #313:generation-backed skill 卸载删 ext-store(不留孤儿)+ 账本,不走 flat removeFsInstall", async () => {
    const { deps, calls } = makeDeps()
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps) // 建 generation store
    const store = skillStorePaths(globalRoot, "demo").store
    expect(fs.existsSync(store)).toBe(true)
    calls.length = 0
    const r = await uninstallByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(store)).toBe(false) // ext-store 删净 —— 孤儿 bug 修复
    expect(findRecordV2(globalRoot, "skill", "demo")).toBeNull()
    expect(called(calls, "removeFsInstall")).toHaveLength(0) // 未走 flat 路径
  })

  test("r19:卸载与并发替换竞争 —— 锁内 configKey 漂移即拒,新装插件的账/授权不被误清", async () => {
    const oldDir = path.join(globalRoot, "plugins", "vp")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(oldJs, "// old")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs] }, null, 2))
    const base = {
      id: "plugin:vp", name: "vp", kind: "plugin" as const, environment: "prod" as const, scope: { kind: "global" as const },
      version: "0.9.0", desiredState: "enabled" as const, origin: "catalog" as const,
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-u1", state: "committed" as const }, installedAt: "2026-07-15T00:00:00.000Z",
    }
    expect(upsertRecordV2(globalRoot, base).ok).toBe(true)
    const newJs = path.join(globalRoot, "plugins", "vp@feed9999", "plugin.js")
    const { deps } = makeDeps({
      installers: {
        // 模拟实物净除与锁获取之间的并发替换:账本已指向新载荷
        removePluginPath: (_name: string, _p: string) => {
          const w = upsertRecordV2(globalRoot, { ...base, version: "1.0.0", configKey: `plugin-path:${newJs}`, transaction: { id: "tx-u2", state: "committed" as const } })
          if (!w.ok) throw new Error(w.reason)
          return { ok: true as const }
        },
      },
    })
    const r = await uninstallByKey({ type: "plugin", name: "vp", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("changed while uninstalling")
    expect(recOf(findRecordV2(globalRoot, "plugin", "vp")).configKey).toBe(`plugin-path:${newJs}`) // 新账原封不动
  })

  test("r18:账本删除失败(同 key 损坏记录拒删)→ 卸载如实报失败,不折叠 warning 谎报成功", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    const ledger = path.join(globalRoot, "installs.json")
    // 注入同 key 损坏 sibling(generation 非法)—— lookup 面仍见合法记录,实物删除后账本删除被 r17 闸拒。
    fs.writeFileSync(ledger, fs.readFileSync(ledger, "utf8").replace('"records": [', '"records": [{"kind":"skill","name":"demo","generation":-5},'))
    const r = await uninstallByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    // r12 B3 后:含损坏 sibling 的 key,lookup 层即 corrupt-match fail-closed 拒(更干净:不再"物删后
    // 账删失败");reason 仍如实标 corrupt + fail closed。
    if (!r.ok) expect(r.reason).toContain("is corrupt")
    // 卸载失败=没删:文件字节仍含 demo 记录(不得谎报「已卸载」)。
    expect(fs.readFileSync(ledger, "utf8")).toContain('"name":"demo"')
  })

  test("not installed → refuse (renderer cannot conjure a receipt)", async () => {
    const { deps, calls } = makeDeps()
    const r = await uninstallByKey({ type: "skill", name: "never-installed", scope: "global" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not installed")
    expect(installerCallCount(calls)).toBe(0)
  })

  test("mcp uninstall(#346): journaled 单锁序列 config→secrets→ledger,journal 终态", async () => {
    const { deps, calls } = makeDeps()
    await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    calls.length = 0
    const r = await uninstallByKey({ type: "mcp", name: "markitdown", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    expect(called(calls, "removeMcpConfigInLock")).toHaveLength(1)
    expect(called(calls, "removeMcpSecretsStrict")).toHaveLength(1)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
    // journal 落盘且终态(op=uninstall/action=config)
    const probe = probeTransactionJournals(globalRoot)
    expect(probe.unreadableDir).toBe(false)
    const un = probe.entries.filter((j) => j.op === "uninstall")
    expect(un).toHaveLength(1)
    expect(un[0]!.state).toBe("uninstalled")
  })

  test("mcp uninstall(#346): config 删除失败 → journal 保持非终态、密钥不吊销、账本不动", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    const { deps: d2, calls: c2 } = makeDeps({ installers: { removeMcpConfigInLock: () => ({ ok: false as const, reason: "primary write failed" }) } })
    const r = await uninstallByKey({ type: "mcp", name: "markitdown", scope: "global" }, d2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("artifact removal failed")
    expect(called(c2, "removeMcpSecretsStrict")).toHaveLength(0) // config 未净除 → 不碰密钥
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).not.toBeNull() // ledger-second:账本未动
    const probe = probeTransactionJournals(globalRoot)
    expect(probe.entries.some((j) => j.op === "uninstall" && j.state === "uninstalling")).toBe(true) // 前滚待恢复
  })

  test("mcp uninstall(#346): 账本删除失败 → artifacts 已净除、journal 非终态待前滚", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, deps)
    // 预热 journal 目录(锁与 journal 都在 ext-tx/ 内,不受根目录只读影响),再把根目录设只读:
    // 账本原子写的 tmp 文件落根目录 → commitLedger 必炸;读账本不受影响。
    fs.mkdirSync(path.join(globalRoot, "ext-tx", "journal"), { recursive: true })
    fs.chmodSync(globalRoot, 0o555)
    const { deps: d3, calls: c3 } = makeDeps()
    let r: Awaited<ReturnType<typeof uninstallByKey>>
    try {
      r = await uninstallByKey({ type: "mcp", name: "markitdown", scope: "global" }, d3)
    } finally {
      fs.chmodSync(globalRoot, 0o755)
    }
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("ledger")
    expect(called(c3, "removeMcpConfigInLock")).toHaveLength(1)
    expect(called(c3, "removeMcpSecretsStrict")).toHaveLength(1)
    const probe = probeTransactionJournals(globalRoot)
    expect(probe.entries.some((j) => j.op === "uninstall" && j.state === "uninstalling")).toBe(true)
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
    if (!r.ok) expect(r.reason).toContain("is not under")
    expect(called(calls, "removePluginPath")).toHaveLength(0)
  })

  test("vendored plugin: matching derived path → removed via re-derived owned path", async () => {
    const { deps, calls } = makeDeps()
    const inst = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(inst.ok).toBe(true)
    const jsPath = inst.ok ? path.join(inst.files![0]!, "plugin.js") : ""
    calls.length = 0
    const r = await uninstallByKey({ type: "plugin", name: "vp", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    const rm = called(calls, "removePluginPath")
    expect(rm).toHaveLength(1)
    // #378:内容寻址目录 plugins/vp@<digest16>(卸载对 <name>@… 布局同样圈禁认可)
    expect(rm[0]!.args[1]).toBe(jsPath)
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
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    await uninstallByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    // #348(Codex 裁决 C2):首驱停在 authorize = 本次 attempt 以 rollback 结束(配对 begin,
    // 非引擎写后回滚);确认重驱是新 attempt → begin/commit。
    expect(txEvents).toHaveLength(6)
    expect(txEvents[0]).toBe("begin:install")
    expect(txEvents[1]).toStartWith("rollback:")
    expect(txEvents[1]).toContain("re-confirmation")
    expect(txEvents.slice(2)).toEqual(["begin:install", "commit", "begin:uninstall", "commit"])
  })
})

// ── deriveMcpConfig 独立面(补充边界)───────────────────────────────────────────────────────────

describe("generation history — list + offline rollback (REQ-100 #313)", () => {
  test("列代:两次安装 → 两个物理 gen(恰一 current、均 eligible),绝对目录不外泄", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    const r = listGenerationsByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generations).toHaveLength(2)
    expect(r.generations.filter((g) => g.current)).toHaveLength(1)
    for (const g of r.generations) {
      expect(g.eligible).toBe(true) // 快照在 → 可离线回滚
      expect((g as Record<string, unknown>).dir).toBeUndefined()
      expect((g as Record<string, unknown>).generationDir).toBeUndefined()
    }
  })

  test("回滚:翻回旧 gen(previous=回滚前 current),指针切换 + 逻辑 generation 只增不倒退", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    const before = listGenerationsByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    if (!before.ok) throw new Error(before.reason)
    const current = before.generations.find((g) => g.current)
    const target = before.generations.find((g) => !g.current)
    if (!current || !target) throw new Error("expected two generations")
    const recBefore = findRecordV2(globalRoot, "skill", "demo")
    const r = await rollbackGenerationByKey({ type: "skill", name: "demo", scope: "global" }, target.genId, deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.previous).toBe(current.genId)
    const after = listGenerationsByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    if (!after.ok) throw new Error(after.reason)
    expect(after.generations.find((g) => g.current)?.genId).toBe(target.genId)
    const recAfter = findRecordV2(globalRoot, "skill", "demo")
    expect(recAfter).not.toBeNull()
    expect(recAfter?.generation ?? 0).toBeGreaterThan(recBefore?.generation ?? 0) // receipt 不分叉:同一记录递增修订
  })

  test("fail-closed:伪造 genId / 非 skill 类型 / project 域全拒,拒后零变更", async () => {
    const { deps } = makeDeps()
    await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    const bad = await rollbackGenerationByKey({ type: "skill", name: "demo", scope: "global" }, "gen-../../escape", deps)
    expect(bad.ok).toBe(false)
    const mcp = listGenerationsByKey({ type: "mcp", name: "markitdown", scope: "global" }, deps)
    expect(mcp.ok).toBe(false)
    const proj = listGenerationsByKey({ type: "skill", name: "demo", scope: "project", projectDir: makeProject("p-genhist") }, deps)
    expect(proj.ok).toBe(false)
    const still = listGenerationsByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    if (!still.ok) throw new Error(still.reason)
    expect(still.generations.filter((g) => g.current)).toHaveLength(1)
  })
})

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

// ── REQ-101 #315:advisory 激活闸接线(planner 五位点;闸语义本体见 ext-advisory-gate.test.ts)──

describe("#315 advisory 激活闸接线", () => {
  const denyGate = (advisoryId = "adv-test-1") => (input: { catalogId: string }) =>
    ({ allowed: false as const, advisoryId, reason: `blocked ${input.catalogId}` })

  test("installCatalog:resolveEntry 后过闸,命中即拒(零安装器调用)", async () => {
    const { deps, calls } = makeDeps({})
    const gated: PlannerDeps = { ...deps, advisoryGate: denyGate() }
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" } }, gated)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toContain("adv-test-1")
    expect(r.reason).toContain("R14")
    expect(calls.filter((c) => c.fn !== "downloadRemoteAsset").length).toBe(0) // 任何安装器都未被触达
  })

  test("bundle child:命中 advisory 的子条目恒跳过(即使 required;REQ-105 语义并入统一闸)", async () => {
    const cleanMcp: CatalogEntry = { ...mcpEntry, id: "mcp:clean", name: "clean", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "clean-mcp@1.0.0"] } }
    const cleanBundle: CatalogEntry = { ...bundleEntry, id: "bundle:clean", name: "cleanb", bundleItems: [{ catalogEntryId: "skill:demo", optional: false, installOrder: 1 }, { catalogEntryId: "mcp:clean", optional: false, installOrder: 2 }] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, cleanMcp, cleanBundle] })
    // 只拦 child(mcp:clean,required),bundle 本体放行
    const gate = (input: { catalogId: string }) =>
      input.catalogId === "mcp:clean"
        ? ({ allowed: false as const, advisoryId: "adv-child", reason: "child blocked" })
        : ({ allowed: true as const })
    const gated: PlannerDeps = { ...deps, advisoryGate: gate }
    const r = await installAuthorized({ catalogId: "bundle:clean", scope: { scope: "global" } }, gated)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.installed?.sort()).toEqual(["skill:demo"]) // 命中子项被跳过,其余照常
    const skipped = (r as unknown as { skipped?: Array<{ id: string; reason: string }> }).skipped ?? []
    expect(skipped.some((x) => x.id === "mcp:clean" && x.reason.includes("adv-child"))).toBe(true)
  })

  test("enable(disabled→enabled)被拦;disable 不受闸", async () => {
    const { deps } = makeDeps({})
    const globalRoot = deps.globalRoot()
    const ok = await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(ok.ok).toBe(true)
    expect((await setInstallStateByKey({ type: "skill", name: "demo", scope: "global", state: "disabled" }, { globalRoot: () => globalRoot, advisoryGate: denyGate(), resolveEntry: async () => null })).ok).toBe(true)
    const re = await setInstallStateByKey({ type: "skill", name: "demo", scope: "global", state: "enabled" }, { globalRoot: () => globalRoot, advisoryGate: denyGate(), resolveEntry: async () => null })
    expect(re.ok).toBe(false)
    if (re.ok) throw new Error("unreachable")
    expect(re.reason).toContain("re-enable refused")
  })

  test("generation rollback 过闸:按**目标代 receipt 快照**身份评估;快照缺失 fail-closed(review M1/M2)", async () => {
    const { deps } = makeDeps({})
    expect((await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)).ok).toBe(true)
    expect((await installAuthorized({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)).ok).toBe(true)
    const gens = listGenerationsByKey({ type: "skill", name: "demo", scope: "global" }, deps)
    if (!gens.ok) throw new Error(gens.reason)
    const target = gens.generations.find((g) => !g.current)!
    // ① 记录 gate 收到的输入:必须来自目标代快照(id/payloadDigest 在场,provenance=cache)
    const seen: Array<{ catalogId: string; payloadDigest?: string; provenance: string }> = []
    const recording = (input: { catalogId: string; payloadDigest?: string; provenance: "remote" | "cache" | "bundled" | "seed" }) => {
      seen.push(input)
      return { allowed: true as const }
    }
    const ok = await rollbackGenerationByKey({ type: "skill", name: "demo", scope: "global" }, target.genId, {
      globalRoot: deps.globalRoot,
      advisoryGate: recording,
    })
    expect(ok.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.catalogId).toBe("skill:demo")
    expect(typeof seen[0]!.payloadDigest).toBe("string") // 目标代 receipt 快照携带的聚合 digest
    expect(seen[0]!.provenance).toBe("cache")
    // ② 命中即拒(回滚被闸)
    const back = gens.generations.find((g) => g.current)! // 现在的旧 current
    const refused = await rollbackGenerationByKey({ type: "skill", name: "demo", scope: "global" }, back.genId, {
      globalRoot: deps.globalRoot,
      advisoryGate: denyGate(),
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error("unreachable")
    expect(refused.reason).toContain("rollback activation refused")
    // ③ 目标快照缺失(伪 genId)→ 无论闸放不放行都 fail-closed(闸无法评估目标身份)
    const noSnap = await rollbackGenerationByKey({ type: "skill", name: "demo", scope: "global" }, "gen-000099-deadbeef", {
      globalRoot: deps.globalRoot,
      advisoryGate: recording,
    })
    expect(noSnap.ok).toBe(false)
    if (noSnap.ok) throw new Error("unreachable")
    expect(noSnap.reason).toContain("receipt snapshot unavailable")
  })
})

// ── #348:capability→authorize 闸接线(生产入口端到端)────────────────────────────────────────────
describe("capability authorize gate via installCatalog (REQ-100 #348)", () => {
  const authzReceiptDir = () => path.join(globalRoot, "ext-tx", "authz")

  test("首装(builtin skill):首驱零权威副作用停在 authorize,带逐 item diff", async () => {
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.stage).toBe("authorize")
    if (r.stage !== "authorize") throw new Error("unreachable")
    expect(r.authorization).toHaveLength(1)
    const diff = r.authorization[0]!
    expect(diff.key).toBe("skill--demo")
    expect(diff.previous).toBeNull()
    expect(diff.requested).toEqual(["prompt:context"])
    expect(diff.added).toEqual(["prompt:context"])
    expect(diff.requiresConfirmation).toBe(true)
    // 零权威副作用:无 generation/receipt/grants/授权收据(CAS blob 是可回收缓存,允许残留)。
    expect(resolveLiveGenerationDir(globalRoot, "skill--demo")).toBeNull()
    expect(findRecordV2(globalRoot, "skill", "demo")).toBeNull()
    expect(readCapabilityGrant(globalRoot, "skill--demo")).toBeNull()
    expect(fs.existsSync(authzReceiptDir())).toBe(false)
  })

  test("确认重驱:grants/授权收据/receipt 落账;decidedAt 由 main 打戳(renderer 无通道)", async () => {
    const { deps } = makeDeps()
    const first = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    const grant = readCapabilityGrant(globalRoot, "skill--demo")
    expect(grant?.capabilities).toEqual(["prompt:context"])
    expect(findRecordV2(globalRoot, "skill", "demo")).not.toBeNull()
    const receipts = fs.readdirSync(authzReceiptDir())
    expect(receipts).toHaveLength(1)
    const receipt = JSON.parse(fs.readFileSync(path.join(authzReceiptDir(), receipts[0]!), "utf8")) as {
      decidedAt: string
      items: Array<{ key: string }>
    }
    expect(typeof receipt.decidedAt).toBe("string")
    expect(receipt.decidedAt.length).toBeGreaterThan(0)
    expect(receipt.items.map((i) => i.key)).toEqual(["skill--demo"])
    // renderer 若尝试自带 decidedAt → 严格解码整体拒绝(审计戳只能 main 生成)。
    const forged = await installCatalog(
      { catalogId: "skill:demo", scope: { scope: "global" }, authorization: { confirmed, decidedAt: "2020-01-01T00:00:00Z" } },
      deps,
    )
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toContain('unknown key "decidedAt"')
  })

  test("已授权后重装不再弹确认(基线覆盖);扩权(基线为子集)重新弹并标 added", async () => {
    const { deps } = makeDeps()
    const first = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    expect((await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" }, authorization: { confirmed } }, deps)).ok).toBe(true)
    // 基线覆盖 → 静默通过,不需要 authorization。
    const again = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(again.ok).toBe(true)
    // 扩权:把基线改写为空集(committed 授权收缩)→ 下次请求 prompt:context = expansion,重新确认。
    writeCapabilityGrantSync(globalRoot, { v: 1, key: "skill--demo", capabilities: [], txId: "t-shrink", grantedAt: new Date().toISOString() })
    const esc = await installCatalog({ catalogId: "skill:demo", scope: { scope: "global" } }, deps)
    expect(esc.ok).toBe(false)
    if (esc.ok || esc.stage !== "authorize") throw new Error("expected escalation authorize")
    expect(esc.authorization[0]!.previous).toEqual([])
    expect(esc.authorization[0]!.added).toEqual(["prompt:context"])
  })

  test("remote skill:authorize 确认重驱走 CAS 复用,绝不二次下载(Codex 必改 5)", async () => {
    const { deps, calls } = makeDeps()
    const first = await installCatalog({ catalogId: "skill:remote-demo", scope: { scope: "global" } }, deps)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1)
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "skill:remote-demo", scope: { scope: "global" }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1) // 重驱零网络
    const live = resolveLiveGenerationDir(globalRoot, "skill--remote-demo")!
    expect(fs.readFileSync(path.join(live, "SKILL.md"), "utf8")).toBe(REMOTE_SKILL_MD)
  })

  test("bundle:逐子项 diff(能力归属不并集化)→ 一次授权一次 commit,逐项 grants + 完整收据", async () => {
    const cleanMcp: CatalogEntry = { ...mcpEntry, id: "mcp:clean", name: "clean", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "clean-mcp@1.0.0"] } }
    const authzBundle: CatalogEntry = { ...bundleEntry, id: "bundle:authz", name: "authzb", bundleItems: [
      { catalogEntryId: "skill:demo", optional: false, installOrder: 1 },
      { catalogEntryId: "mcp:clean", optional: false, installOrder: 2 },
      { catalogEntryId: "cloud:research", optional: false, installOrder: 3 },
    ] }
    const { deps } = makeDeps({ entries: [...ALL_ENTRIES, cleanMcp, authzBundle] })
    const first = await installCatalog({ catalogId: "bundle:authz", scope: { scope: "global" } }, deps)
    expect(first.ok).toBe(false)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    const byKey = Object.fromEntries(first.authorization.map((d) => [d.key, d]))
    expect(byKey["skill--demo"]!.requested).toEqual(["prompt:context"])
    expect(byKey["mcp--clean"]!.requested.slice().sort()).toEqual(["engine:config", "process:spawn"])
    expect(byKey["cloud--research"]!.requested).toEqual(["cloud:dispatch"])
    expect(first.authorization.every((d) => d.requiresConfirmation && d.previous === null)).toBe(true)
    // 零权威副作用(bundle 同样)。
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "bundle:authz", scope: { scope: "global" }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.installed?.slice().sort()).toEqual(["cloud:research", "mcp:clean", "skill:demo"])
    expect(readCapabilityGrant(globalRoot, "skill--demo")?.capabilities).toEqual(["prompt:context"])
    expect(readCapabilityGrant(globalRoot, "mcp--clean")?.capabilities?.slice().sort()).toEqual(["engine:config", "process:spawn"])
    expect(readCapabilityGrant(globalRoot, "cloud--research")?.capabilities).toEqual(["cloud:dispatch"])
    const receipts = fs.readdirSync(authzReceiptDir())
    expect(receipts).toHaveLength(1)
    const receipt = JSON.parse(fs.readFileSync(path.join(authzReceiptDir(), receipts[0]!), "utf8")) as { items: Array<{ key: string }> }
    expect(receipt.items.map((i) => i.key).sort()).toEqual(["cloud--research", "mcp--clean", "skill--demo"])
  })

  test("authorization 严格解码:结构/资源边界违规整体拒绝;合法确认重建全新对象", () => {
    const base = { catalogId: "skill:demo", scope: { scope: "global" } }
    const bad = (authorization: unknown) => {
      const d = decodeCatalogInstallIntent({ ...base, authorization })
      expect(d.ok).toBe(false)
      return d.ok ? "" : d.reason
    }
    expect(bad("yes")).toContain("must be an object")
    expect(bad({ confirmed: {}, extra: 1 })).toContain('unknown key "extra"')
    expect(bad({ confirmed: {}, decidedAt: "2026-01-01" })).toContain('unknown key "decidedAt"')
    expect(bad({})).toContain("confirmed: required object")
    expect(bad({ confirmed: [] })).toContain("confirmed: required object")
    expect(bad({ confirmed: { "bad key!": ["prompt:context"] } })).toContain("invalid item key")
    expect(bad({ confirmed: { [`k${"x".repeat(128)}`]: [] } })).toContain("invalid item key") // >128
    expect(bad({ confirmed: { k: "prompt:context" } })).toContain("array of ≤32")
    expect(bad({ confirmed: { k: Array.from({ length: 33 }, (_, i) => `cap:${i}`) } })).toContain("array of ≤32")
    expect(bad({ confirmed: { k: ["prompt:context", "prompt:context"] } })).toContain("duplicate capability")
    expect(bad({ confirmed: { k: ["bad cap with spaces"] } })).toContain("unsafe capability")
    expect(bad({ confirmed: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, []])) })).toContain("too many items")
    const source = { confirmed: { "skill--demo": ["prompt:context"] } }
    const good = decodeCatalogInstallIntent({ ...base, authorization: source })
    expect(good.ok).toBe(true)
    if (!good.ok || !("authorization" in good.intent)) throw new Error("unreachable")
    expect(good.intent.authorization).toEqual({ confirmed: { "skill--demo": ["prompt:context"] } })
    expect(good.intent.authorization === source).toBe(false) // 重建,不保留 renderer 对象引用
    expect(good.intent.authorization!.confirmed["skill--demo"] === source.confirmed["skill--demo"]).toBe(false)
  })

  test("seed 意图同样接受 authorization 字段(解码面),拒绝未知键不变", () => {
    const ok = decodeCatalogInstallIntent({ source: "seed", assetId: "skill:hello", scope: { scope: "global" }, authorization: { confirmed: {} } })
    expect(ok.ok).toBe(true)
    const bad = decodeCatalogInstallIntent({ source: "seed", assetId: "skill:hello", scope: { scope: "global" }, authorization: { confirmed: {}, decidedAt: "x" } })
    expect(bad.ok).toBe(false)
  })
})

// ── #348 补:bundle remote 子项的重驱缓存(classify 分支独立于单装路径)──────────────────────────
describe("bundle remote child redrive cache (REQ-100 #348)", () => {
  test("bundle 内 remote skill:authorize 确认重驱零下载(classifyBundleChild CAS 命中)", async () => {
    const remoteBundle: CatalogEntry = { ...bundleEntry, id: "bundle:remote", name: "remoteb", bundleItems: [{ catalogEntryId: "skill:remote-demo", optional: false, installOrder: 1 }] }
    const { deps, calls } = makeDeps({ entries: [...ALL_ENTRIES, remoteBundle] })
    const first = await installCatalog({ catalogId: "bundle:remote", scope: { scope: "global" } }, deps)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1)
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "bundle:remote", scope: { scope: "global" }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1) // 重驱零网络(bundle classify 分支)
    expect(resolveLiveGenerationDir(globalRoot, "skill--remote-demo")).not.toBeNull()
  })
})

// ── #354:非 generation 提交面 fail-closed(账本写失败 = 安装失败 + 按类型补偿)────────────────────
describe("fail-closed non-generation ledger commit (REQ-100 #354)", () => {
  const seedRecord = (kind: "plugin" | "agent", name: string) => {
    const w = upsertRecordV2(globalRoot, {
      id: `${kind}:${name}`,
      name,
      kind,
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    })
    if (!w.ok) throw new Error(w.reason)
  }
  const runningAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0
  const lockRoot = () => fs.chmodSync(globalRoot, 0o555)
  const unlockRoot = () => fs.chmodSync(globalRoot, 0o755)

  test("mcp:根只读 → 事务失败 fail-closed;本次密钥版本目录清理,零残留(#378 引擎回滚取代手工补偿)", async () => {
    const { deps, calls } = makeDeps()
    if (runningAsRoot()) return // root 下 0o555 仍可写(review minor:假红而非假绿)
    lockRoot()
    try {
      const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "sekret" } } }, deps)
      expect(r.ok).toBe(false)
    } finally {
      unlockRoot()
    }
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
    // 本次版本目录清理(密钥文件在 userData 侧可写,失败路径不留孤儿)
    const rm = called(calls, "removeMcpSecretVersionDir")
    expect(rm).toHaveLength(1)
    expect(fs.existsSync(path.join(tmp, "mcp-secrets", "markitdown", strOf(rm[0]!.args[1])))).toBe(false)
  })

  test("mcp:成功路径 —— 版本 GC 只在提交成功后触发;authorize 暂停清理本次版本;v1 视图由 v2 锁步派生", async () => {
    const { deps, calls } = makeDeps()
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "sekret" } } }, deps)
    expect(r.ok).toBe(true)
    // 两驱:首驱 authorize 暂停(写→清各一次),重驱成功(写一次 + GC 一次,零清理)
    expect(called(calls, "writeMcpSecretVersioned")).toHaveLength(2)
    expect(called(calls, "removeMcpSecretVersionDir")).toHaveLength(1)
    expect(called(calls, "gcMcpSecrets")).toHaveLength(1)
    const ledger = JSON.parse(fs.readFileSync(path.join(globalRoot, "installs.json"), "utf8")) as {
      records: Array<{ kind: string; name: string }>
      receipts: Array<{ type: string; name: string; configKey?: string }>
    }
    expect(ledger.records.some((x) => x.kind === "mcp" && x.name === "markitdown")).toBe(true)
    expect(ledger.receipts.some((x) => x.type === "mcp" && x.name === "markitdown" && x.configKey === "mcp.markitdown")).toBe(true)
  })

  test("mcp:strict 叶前像不可读(形状异常)→ 写前拒绝,零副作用", async () => {
    const { deps, calls } = makeDeps({
      installers: { readMcpLeafStrict: () => ({ ok: false as const, reason: "mcp.markitdown has unexpected shape" }) },
    })
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "s" } } }, deps)
    expect(r.ok).toBe(false)
    expect(called(calls, "writeMcpSecretVersioned")).toHaveLength(0)
    expect(called(calls, "applyMcpWritePolicy")).toHaveLength(0)
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
  })

  test("plugin(npm):有账在场 → 写前拒绝(更新归 #352 原子替换),零 installer 触碰", async () => {
    seedRecord("plugin", "np")
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing replace") // #352:无 configKey 的账 = 模糊态,拒 replace 也拒 fresh
    expect(called(calls, "persistPlugin")).toHaveLength(0)
  })

  test("plugin(npm):无账但 config 已有恰同钉版 → 拒绝静默认领(#378 跨源严格检查),零写入", async () => {
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: ["@alpha/np@2.3.4"] }))
    const before = fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing to adopt or double-install")
    expect(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")).toBe(before)
  })

  test("plugin(npm):根只读 → 事务失败 fail-closed,config/账本零残留(#378 引擎回滚取代精确补偿)", async () => {
    const { deps } = makeDeps()
    if (runningAsRoot()) return // root 下 0o555 仍可写(review minor:假红而非假绿)
    lockRoot()
    try {
      const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
      expect(r.ok).toBe(false)
    } finally {
      unlockRoot()
    }
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "plugin", "np")).toBeNull()
  })

  test("plugin(vendored):无账目录在场 → 写前拒绝;根只读 → 事务失败零残留", async () => {
    fs.mkdirSync(path.join(globalRoot, "plugins", "vp"), { recursive: true })
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("without a ledger record")
    fs.rmSync(path.join(globalRoot, "plugins", "vp"), { recursive: true, force: true })

    const { deps: d2 } = makeDeps()
    if (runningAsRoot()) return // root 下 0o555 仍可写(review minor:假红而非假绿)
    lockRoot()
    try {
      const r2 = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
      expect(r2.ok).toBe(false)
    } finally {
      unlockRoot()
    }
    // #378:引擎回滚零残留(config/账本;根只读时事务在 journal 期即拒)
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "plugin", "vp")).toBeNull()
  })

  test("agent:有账或文件在场 → 写前拒绝(无更新链,不静默覆盖/认领),零内容副作用", async () => {
    seedRecord("agent", "helper")
    const { deps, calls } = makeDeps({ entries: [...ALL_ENTRIES, agentBuiltinEntry] })
    const r = await installCatalog({ catalogId: "agent:helper", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    expect(called(calls, "collectBuiltinAgentPayload")).toHaveLength(0)

    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })
    const { deps: d2, calls: c2 } = makeDeps({ entries: [...ALL_ENTRIES, agentBuiltinEntry], installers: { agentPresent: () => true } })
    const r2 = await installCatalog({ catalogId: "agent:helper", scope: { scope: "global" } }, d2)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("already present")
    expect(called(c2, "collectBuiltinAgentPayload")).toHaveLength(0)
  })

  test("agent:根只读 → 事务失败 fail-closed,零残留(#361:引擎回滚取代手工补偿)", async () => {
    // 预写授权基线(与请求集同)→ authorize 闸静默通过,单次驱动直达引擎写路径。
    writeCapabilityGrantSync(globalRoot, { v: 1, key: "agent--helper", capabilities: ["engine:config", "prompt:context"], txId: "t0", grantedAt: new Date().toISOString() })
    const { deps, calls } = makeDeps({ entries: [...ALL_ENTRIES, agentBuiltinEntry] })
    if (runningAsRoot()) return // root 下 0o555 仍可写(review minor:假红而非假绿)
    lockRoot()
    try {
      const r = await installCatalog({ catalogId: "agent:helper", scope: { scope: "global" } }, deps)
      expect(r.ok).toBe(false)
    } finally {
      unlockRoot()
    }
    // 引擎回滚零残留:无 md、无 config 叶、无账;补偿不再是 planner 手工调用。
    expect(fs.existsSync(path.join(globalRoot, "agents", "helper.md"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "helper")).toBeNull()
    if (fs.existsSync(path.join(globalRoot, "alpha.jsonc"))) {
      expect(readAgentLeaf(globalRoot, "helper")).toBeUndefined()
    }
    expect(called(calls, "removeFsInstall")).toHaveLength(0)
  })

  test("cloud:根只读 → 事务失败 fail-closed,零账本(receipts-only 同样 journaled,#378)", async () => {
    const { deps, calls } = makeDeps()
    if (runningAsRoot()) return // root 下 0o555 仍可写(review minor:假红而非假绿)
    lockRoot()
    try {
      const r = await installCatalog({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
      expect(r.ok).toBe(false)
      expect(installerCallCount(calls)).toBe(0)
    } finally {
      unlockRoot()
    }
    expect(findRecordV2(globalRoot, "cloud", "research")).toBeNull()
  })

  test("损坏账本(garbage JSON)→ 写前拒绝且原文件不动(quarantine 不是提交路径)", async () => {
    fs.writeFileSync(path.join(globalRoot, "installs.json"), "{ definitely not json")
    const before = fs.readFileSync(path.join(globalRoot, "installs.json"))
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("install ledger corrupt")
    expect(fs.readFileSync(path.join(globalRoot, "installs.json")).equals(before)).toBe(true)
    expect(fs.existsSync(path.join(globalRoot, "ext-tx"))).toBe(false) // 无 quarantine 触发
    expect(installerCallCount(calls)).toBe(0)
  })

  test("v1-only receipt 同样触发写前拒绝(历史 eager v1 遗物;npm 按规范化名双查)", async () => {
    // npm 插件历史 eager v1 名 = pluginRecordName("@alpha/np") = "alpha__np"(≠ entry.name "np")。
    addReceipt(globalRoot, { id: "plugin:np", name: "alpha__np", type: "plugin", scope: "global", installedAt: new Date().toISOString(), origin: "catalog", configKey: "plugin:@alpha/np@2.3.4" })
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("v1-only")
    expect(called(calls, "persistPlugin")).toHaveLength(0)

    addReceipt(globalRoot, { id: "agent:helper", name: "helper", type: "agent", scope: "global", installedAt: new Date().toISOString(), origin: "catalog" })
    const { deps: d2, calls: c2 } = makeDeps({ entries: [...ALL_ENTRIES, agentBuiltinEntry] })
    const r2 = await installCatalog({ catalogId: "agent:helper", scope: { scope: "global" } }, d2)
    expect(r2.ok).toBe(false)
    expect(called(c2, "collectBuiltinAgentPayload")).toHaveLength(0)
  })

  test("#378 Q2:authorize 暂停 = 零权威副作用 —— 无 config/账/grant,本次密钥版本已清;策略 provisioning(空目录)允许残留", async () => {
    const managed = path.join(tmp, "managed-workspace")
    const { deps, calls } = makeDeps({
      installers: {
        // 模拟非权威 provisioning:策略闸口建受管空目录(mkdir/realpath 同款副作用)。
        applyMcpWritePolicy: (_name, _server) => {
          fs.mkdirSync(managed, { recursive: true })
          return { ok: true as const }
        },
      },
    })
    const first = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "s" } } }, deps)
    expect(first.ok).toBe(false)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    expect(first.authorization.length).toBeGreaterThan(0)
    // 零权威副作用:无 config 叶、无账、无 grant;本次密钥版本目录已清(用户确认前零明文残留)
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
    expect(readCapabilityGrant(globalRoot, "mcp--markitdown")).toBeNull()
    const rm = called(calls, "removeMcpSecretVersionDir")
    expect(rm).toHaveLength(1)
    expect(fs.existsSync(path.join(tmp, "mcp-secrets", "markitdown", strOf(rm[0]!.args[1])))).toBe(false)
    expect(fs.existsSync(managed)).toBe(true) // 非权威 provisioning:空受管目录允许残留
    // 带确认重驱成功 → grant 落账
    const confirmed = Object.fromEntries(first.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "s" } }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    expect(readCapabilityGrant(globalRoot, "mcp--markitdown")).not.toBeNull()
  })

  test("账本前像不可读(installs.json 是目录)→ 写前拒绝,零副作用", async () => {
    fs.mkdirSync(path.join(globalRoot, "installs.json"), { recursive: true })
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "s" } } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("install ledger unreadable")
    expect(called(calls, "persistMcp")).toHaveLength(0)
    expect(called(calls, "fileifyMcpSecrets")).toHaveLength(0)
  })
})

// ── #378 退出条件:三类单装全走事务 + 首装 authorize 生产入口 + cloud 卸载清授权账 ────────────────
describe("single-install transactionalization exit criteria (REQ-100 #378)", () => {
  test("首装无 authorization → stage=\"authorize\"(生产入口,mcp/plugin-vendored/plugin-npm/cloud 各一)", async () => {
    const cases: Array<{ catalogId: string; key: string; grants?: Record<string, unknown> }> = [
      { catalogId: "mcp:markitdown", key: "mcp--markitdown", grants: { secrets: { API_KEY: "v" } } },
      { catalogId: "plugin:vp", key: "plugin--vp" },
      { catalogId: "plugin:np", key: "plugin--np" },
      { catalogId: "cloud:research", key: "cloud--research" },
    ]
    for (const c of cases) {
      const { deps } = makeDeps()
      const r = await installCatalog({ catalogId: c.catalogId, scope: { scope: "global" }, ...(c.grants ? { grants: c.grants } : {}) }, deps)
      expect(r.ok).toBe(false)
      if (r.ok || r.stage !== "authorize") throw new Error(`expected authorize pause for ${c.catalogId}, got ${JSON.stringify(r)}`)
      expect(r.authorization.some((d) => d.key === c.key)).toBe(true)
      // 零权威副作用:无账、无 grant
      expect(readCapabilityGrant(globalRoot, c.key)).toBeNull()
      // 各类型重驱成功 → grant 落账(#348 契约对全类型生效)
      const confirmed = Object.fromEntries(r.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]))
      const second = await installCatalog(
        { catalogId: c.catalogId, scope: { scope: "global" }, ...(c.grants ? { grants: c.grants } : {}), authorization: { confirmed } },
        deps,
      )
      expect(second.ok).toBe(true)
      expect(readCapabilityGrant(globalRoot, c.key)).not.toBeNull()
      // 每轮独立根(beforeEach 只在测试间跑,这里手动重建)
      fs.rmSync(globalRoot, { recursive: true, force: true })
      fs.mkdirSync(globalRoot, { recursive: true })
    }
  })

  test("cloud 卸载(D4):grants 清除成功前置;record 与 grant 双清", async () => {
    const { deps } = makeDeps()
    const inst = await installAuthorized({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(inst.ok).toBe(true)
    expect(readCapabilityGrant(globalRoot, "cloud--research")).not.toBeNull()
    const u = await uninstallByKey({ type: "cloud", name: "research", scope: "global" }, deps)
    expect(u.ok).toBe(true)
    expect(readCapabilityGrant(globalRoot, "cloud--research")).toBeNull()
    expect(findRecordV2(globalRoot, "cloud", "research")).toBeNull()
  })

  test("cloud 重装(Q3):desiredState 显式继承 —— disabled 不被静默写回 enabled", async () => {
    const { deps } = makeDeps()
    const inst = await installAuthorized({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(inst.ok).toBe(true)
    const flipped = setDesiredStateV2(globalRoot, "cloud", "research", "disabled")
    expect(flipped.ok).toBe(true)
    const again = await installAuthorized({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(again.ok).toBe(true)
    expect(findRecordV2(globalRoot, "cloud", "research")?.desiredState).toBe("disabled")
  })

  test("r1:锁内密钥在场门 —— 版本文件在取锁前消失(并发 GC/外部清理)→ precondition 拒,零提交", async () => {
    const { deps } = makeDeps({
      installers: {
        // 谎报成功但不落文件 = 模拟「写后、入锁前被并发 GC 收走」的时序
        writeMcpSecretVersioned: (name: string, verId: string, varName: string, _value: string) => ({
          ok: true as const,
          ref: `{file:${path.join(tmp, "mcp-secrets", name, verId, varName)}}`,
        }),
      },
    })
    const r = await installAuthorized({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "v" } } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("secret file")
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false) // 绝不提交悬空引用
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
  })

  test("r1:cloudDesiredStateGate —— plan 快照与锁内现状不一致即拒(锁内漂移门直接单测)", () => {
    expect(cloudDesiredStateGate(globalRoot, "research", "enabled").ok).toBe(true) // 无记录 = enabled
    const w = upsertRecordV2(globalRoot, {
      id: "cloud:research",
      name: "research",
      kind: "cloud",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "disabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    })
    expect(w.ok).toBe(true)
    expect(cloudDesiredStateGate(globalRoot, "research", "enabled").ok).toBe(false)
    expect(cloudDesiredStateGate(globalRoot, "research", "disabled").ok).toBe(true)
  })

  test("r1:cloud 卸载持 bundle 锁 —— 事务在途 busy 即拒,释放后可卸", async () => {
    const { deps } = makeDeps()
    const inst = await installAuthorized({ catalogId: "cloud:research", scope: { scope: "global" } }, deps)
    expect(inst.ok).toBe(true)
    const held = tryAcquireBundleLock(globalRoot, { txId: "test-busy" })
    expect(held.ok).toBe(true)
    try {
      const u = await uninstallByKey({ type: "cloud", name: "research", scope: "global" }, deps)
      expect(u.ok).toBe(false)
      if (!u.ok) expect(u.reason).toContain("busy")
      expect(findRecordV2(globalRoot, "cloud", "research")).not.toBeNull() // 锁内零删除
      expect(readCapabilityGrant(globalRoot, "cloud--research")).not.toBeNull()
    } finally {
      if (held.ok) held.lock.release()
    }
    const u2 = await uninstallByKey({ type: "cloud", name: "research", scope: "global" }, deps)
    expect(u2.ok).toBe(true)
  })

  test("r2:fresh 拒绝同名其他 digest 的未策展派生路径(vendored 与 npm 双入口,防双载)", async () => {
    const stray = path.join(globalRoot, "plugins", "vp@deadbeefdeadbeef", "plugin.js")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [stray] }))
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("without a ledger record")
    const strayNp = path.join(globalRoot, "plugins", "np@aaaabbbbccccdddd", "plugin.js")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [strayNp] }))
    const r2 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("without a ledger record")
    // 双入口都零写入
    expect(JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))).toEqual({ plugin: [strayNp] })
  })

  test("r5:authorize 暂停时本次密钥版本清理失败 → 降级普通失败(不返回 authorize),明文位置入 reason", async () => {
    const { deps } = makeDeps({
      installers: {
        removeMcpSecretVersionDir: (_name: string, _verId: string) => ({ ok: false as const, reason: "EACCES: permission denied" }),
      },
    })
    const first = await installCatalog({ catalogId: "mcp:markitdown", scope: { scope: "global" }, grants: { secrets: { API_KEY: "v" } } }, deps)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBeUndefined() // 不冒充干净的 authorize 暂停
    expect(first.reason).toContain("cleanup is not proven")
    expect(first.reason).toContain("plaintext")
  })

  test("r7:escape-hatch 真源路由 → 事务单装 fail-closed 拒(mcp/npm/vendored 三入口),零写零账", async () => {
    const { deps } = makeDeps({ installers: { mcpConfigTruthPath: () => "/elsewhere/opencode.jsonc" } })
    for (const c of [
      { catalogId: "mcp:markitdown", grants: { secrets: { API_KEY: "v" } } },
      { catalogId: "plugin:np" },
      { catalogId: "plugin:vp" },
    ]) {
      const r = await installCatalog({ catalogId: c.catalogId, scope: { scope: "global" }, ...(c.grants ? { grants: c.grants } : {}) }, deps)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("escape-hatch")
    }
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(fs.existsSync(path.join(globalRoot, "installs.json"))).toBe(false)
  })

  test("r11:escape-hatch 真源路由 → bundle MCP child 同拒(fatal,整单 fail-closed)", async () => {
    const cleanMcp = { ...mcpEntry, id: "mcp:clean2", name: "clean2", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", "clean-mcp@1.0.0"] } } as CatalogEntry
    const cleanBundle = { ...bundleEntry, id: "bundle:clean2", name: "cleanb2", bundleItems: [{ catalogEntryId: "mcp:clean2", optional: false, installOrder: 1 }] } as CatalogEntry
    const { deps } = makeDeps({
      entries: [...ALL_ENTRIES, cleanMcp, cleanBundle],
      installers: { mcpConfigTruthPath: () => "/elsewhere/opencode.jsonc" },
    })
    const r = await installCatalog({ catalogId: "bundle:clean2", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("escape-hatch")
    expect(fs.existsSync(path.join(globalRoot, "installs.json"))).toBe(false)
  })

  test("r6:vendored 内容身份交叉在分发前 —— 配错 vendoredAssetKey 的 replace/fresh 一律拒", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    // 已有 victim 记录 + 配错 key 的高版本 entry:replace 分支不得绕过身份绑定
    const drifted = {
      ...pluginVendoredEntry,
      version: "1.0.1",
      installSpec: { kind: "plugin", package: "@alpha/vp", vendoredAssetKey: "plugins/other" },
    } as CatalogEntry
    const { deps: d2 } = makeDeps({ entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), drifted] })
    const upd = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
    expect(upd.ok).toBe(false)
    if (!upd.ok) expect(upd.reason).toContain("content identity drift")
  })

  test("r6:legacy XDG 源 —— 同名派生路径拒(vendored/npm 双入口);legacy 非法/不可读 fail-closed", async () => {
    const legacyPath = path.join(globalRoot, "plugins", "vp@1111222233334444", "plugin.js")
    const withLegacy = (value: unknown[], fail = false) => ({
      installers: {
        readLegacyPluginArrayStrict: () =>
          fail
            ? { ok: false as const, reason: "legacy config plugin[] contains invalid entries" }
            : { ok: true as const, sources: [{ value, configDir: path.join(tmp, "legacy") }] },
      },
    })
    const { deps } = makeDeps(withLegacy([legacyPath]))
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("legacy config contains")
    const { deps: dNp } = makeDeps(withLegacy([path.join(globalRoot, "plugins", "np@5555666677778888", "plugin.js")]))
    const r2 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, dNp)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("legacy config contains")
    // legacy 非法成员/不可读 → fail-closed(引擎会拒整份合并配置,不得落账谎报成功)
    const { deps: dBad } = makeDeps(withLegacy([], true))
    const r3 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, dBad)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.reason).toContain("invalid entries")
  })

  test("r10:等价重复条目(同一引擎 load 身份)→ replace 收敛为单条;npm 同包兄弟 pin → 拒", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    const oldJs = path.join(v1.files![0]!, "plugin.js")
    // 绝对 + 等价相对重复条目(引擎去重后同一身份)
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs, `./${path.relative(globalRoot, oldJs)}`] }))
    const v2Entry = { ...pluginVendoredEntry, version: "1.0.1" } as CatalogEntry
    const { deps: d2 } = makeDeps({
      entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), v2Entry],
      installers: {
        collectVendoredPluginPayload: (_key: string, name: string) => ({
          ok: true as const,
          files: [{ path: "plugin.js", data: Buffer.from(`// vendored ${name} v1.0.1`) }],
        }),
      },
    })
    const upd = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
    expect(upd.ok).toBe(true) // 不再按原始条目数误判 drift
    expect(pluginArrayOnDisk()).toHaveLength(1) // 等价重复收敛为单条
    // r11:收敛保留**最后一条**的形态/options(引擎 later-wins)—— 前条纯字符串 + 后条带
    // options 的元组,置换后 options 必须存活。
    const v2Js = strOf((() => { const a = pluginArrayOnDisk()[0]; return Array.isArray(a) ? a[0] : a })())
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [v2Js, [`./${path.relative(globalRoot, v2Js)}`, { lazy: true }]] }))
    const v3Entry = { ...pluginVendoredEntry, version: "1.0.2" } as CatalogEntry
    const { deps: dOpts } = makeDeps({
      entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), v3Entry],
      installers: {
        collectVendoredPluginPayload: (_key: string, name: string) => ({
          ok: true as const,
          files: [{ path: "plugin.js", data: Buffer.from(`// vendored ${name} v1.0.2`) }],
        }),
      },
    })
    const upd3 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, dOpts)
    expect(upd3.ok).toBe(true)
    const after3 = pluginArrayOnDisk()
    expect(after3).toHaveLength(1)
    expect(Array.isArray(after3[0])).toBe(true) // 保留后条元组形态
    const tup = after3[0]
    if (Array.isArray(tup)) expect(tup[1]).toEqual({ lazy: true }) // options 存活
    // npm:同包兄弟 pin 在场 → 置换歧义拒
    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })
    fs.rmSync(path.join(globalRoot, "alpha.jsonc"), { force: true })
    const { deps: d3 } = makeDeps()
    const np1 = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, d3)
    expect(np1.ok).toBe(true)
    const cur = pluginArrayOnDisk()
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [...cur, "@alpha/np@9.9.9"] }))
    const npV2 = { ...pluginNpmEntry, version: "2.3.5", installSpec: { kind: "plugin", package: "@alpha/np", version: "2.3.5" } } as CatalogEntry
    const { deps: d4 } = makeDeps({ entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:np"), npV2] })
    const npUpd = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, d4)
    expect(npUpd.ok).toBe(false)
    if (!npUpd.ok) expect(npUpd.reason).toContain("other pins")
    // r11:legacy 源的同包 pin 同样拒(引擎合并去重可能加载 legacy 版本)
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: cur }))
    const { deps: d5 } = makeDeps({
      entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:np"), npV2],
      installers: {
        readLegacyPluginArrayStrict: () => ({ ok: true as const, sources: [{ value: ["@alpha/np@9.9.9"], configDir: path.join(tmp, "legacy") }] }),
      },
    })
    const npUpd2 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, d5)
    expect(npUpd2.ok).toBe(false)
    if (!npUpd2.ok) expect(npUpd2.reason).toContain("legacy config contains pin")
  })

  test("r9:vendored 条目被等价改写为相对形态 → dispatch/replace 按引擎语义仍可更新", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    const oldJs = path.join(v1.files![0]!, "plugin.js")
    // 把绝对条目改写为等价相对形态(引擎按 config 目录解析,合法配置)
    const rel = `./${path.relative(globalRoot, oldJs)}`
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [rel] }))
    const v2Entry = { ...pluginVendoredEntry, version: "1.0.1" } as CatalogEntry
    const { deps: d2 } = makeDeps({
      entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), v2Entry],
      installers: {
        collectVendoredPluginPayload: (_key: string, name: string) => ({
          ok: true as const,
          files: [{ path: "plugin.js", data: Buffer.from(`// vendored ${name} v1.0.1`) }],
        }),
      },
    })
    const upd = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
    expect(upd.ok).toBe(true) // 不再被词法比较误判 ledger drift
    const arr = pluginArrayOnDisk()
    expect(arr).toHaveLength(1)
    expect(strOf(arr[0])).not.toBe(rel) // 已换元为新落点
  })

  test("r5:元组 [spec, options] —— 合法元组可被 replace 换首项保留 options;非法形状拒", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    // 把安装条目改写为引擎合法元组(带 options);replace 必须能按 spec 头对账并换元
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [["@alpha/np@2.3.4", { lazy: true }]] }))
    const v2Entry = { ...pluginNpmEntry, version: "2.3.5", installSpec: { kind: "plugin", package: "@alpha/np", version: "2.3.5" } } as CatalogEntry
    const { deps: d2 } = makeDeps({ entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:np"), v2Entry] })
    const upd = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, d2)
    expect(upd.ok).toBe(true)
    expect(pluginArrayOnDisk()).toEqual([["@alpha/np@2.3.5", { lazy: true }]]) // 换首项保留 options
    // 引擎非法形状(["x"] / ["x", null])在 strict 读被拒 → 新装 fail-closed
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [["only-head"]] }))
    const bad = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain("invalid entries")
  })

  test("r3:相对与 file:// 等价形态的同名 stray 同样被拒(引擎按 config 目录解析路径条目)", async () => {
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: ["./plugins/vp@0011223344556677/plugin.js"] }))
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("without a ledger record")
    const fileUrl = `file://${path.join(globalRoot, "plugins", "np@8899aabbccddeeff", "plugin.js")}`
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [fileUrl] }))
    const r2 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("without a ledger record")
  })

  test("r2:replace 失败清理按 live 引用判定 —— config 已含 staged jsPath 时目录保留", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    // 触发 replace(高版本)+ 事务在途 busy → 失败;fake stager 落点固定 plugins/vp@feed1234,
    // 预先把该 jsPath 塞进 live plugin[](模拟「config 已指向 staged 载荷」的 retained 形态)。
    const stagedJs = path.join(globalRoot, "plugins", "vp@feed1234", "plugin.js")
    const cur = pluginArrayOnDisk()
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [...cur, stagedJs] }))
    const v2Entry = { ...pluginVendoredEntry, version: "1.0.1" } as CatalogEntry
    const { deps: d2 } = makeDeps({ entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), v2Entry] })
    const upd = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
    expect(upd.ok).toBe(false)
    // 保守清理:live 引用在场 → staged 目录不删(删除会制造「config 指向缺失载荷」)
    expect(fs.existsSync(path.join(globalRoot, "plugins", "vp@feed1234"))).toBe(true)
  })

  test("plugin 更新失败 → 旧版继续健康(config 指旧 jsPath、旧目录原样、账本不动)", async () => {
    const { deps } = makeDeps()
    const v1 = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    const oldDir = v1.files![0]!
    const oldJs = path.join(oldDir, "plugin.js")
    const oldBytes = fs.readFileSync(oldJs, "utf8")
    const recBefore = JSON.stringify(findRecordV2(globalRoot, "plugin", "vp"))
    // 高版本 entry(触发 replace)+ 事务在途 busy → 更新失败
    const v2Entry = { ...pluginVendoredEntry, version: "1.0.1" } as CatalogEntry
    const { deps: d2 } = makeDeps({
      entries: [...ALL_ENTRIES.filter((e) => e.id !== "plugin:vp"), v2Entry],
      installers: {
        collectVendoredPluginPayload: (_key: string, name: string) => ({
          ok: true as const,
          files: [{ path: "plugin.js", data: Buffer.from(`// vendored ${name} v1.0.1`) }],
        }),
      },
    })
    const held = tryAcquireBundleLock(globalRoot, { txId: "test-busy" })
    expect(held.ok).toBe(true)
    try {
      const upd = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, d2)
      expect(upd.ok).toBe(false)
    } finally {
      if (held.ok) held.lock.release()
    }
    // 旧版继续健康:实物在、字节不变、config 仍指旧 jsPath、账本原样
    expect(fs.readFileSync(oldJs, "utf8")).toBe(oldBytes)
    expect(pluginArrayOnDisk()).toEqual([oldJs])
    expect(JSON.stringify(findRecordV2(globalRoot, "plugin", "vp"))).toBe(recBefore)
  })
})

// ── #352:catalog 插件原子替换(journaled 事务;fresh/replace/refuse 三态分发)────────────────────
describe("atomic plugin replace via installCatalog (REQ-099 #352)", () => {
  const npDigest = () => {
    const d = decodeManifestV2(synthesizeManifest({ entry: pluginNpmEntry, channel: "remote", catalogVersion: "2026-07-13.1" }))
    if (!d.ok) throw new Error("fixture manifest invalid")
    return computeManifestDigest(d.manifest)
  }
  const seedNpmOld = (over: { pinned?: string; digest?: string; desiredState?: "enabled" | "disabled"; name?: string; id?: string; version?: string } = {}) => {
    const pinned = over.pinned ?? "@alpha/np@2.0.0"
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [pinned] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: over.id ?? "plugin:np",
      name: over.name ?? "np",
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      version: over.version ?? "2.0.0",
      ...(over.digest ? { manifestDigest: over.digest } : {}),
      desiredState: over.desiredState ?? "enabled",
      origin: "catalog",
      configKey: `plugin:${pinned}`,
      transaction: { id: "tx-old-1", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    return w.record
  }

  test("npm 替换:同一事务换元 + receipt 落账;generation/previous 链、desiredState 继承、authorize 闸全通", async () => {
    const old = seedNpmOld({ desiredState: "disabled", digest: `sha256:${"c".repeat(64)}` })
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    // #395:disabled 插件的置换保持 plugin[] 缺席(丢旧不加新;更新 disabled 不重新启用),内容/账本照常换代。
    expect(cfg.plugin).toEqual([])
    const rec = findRecordV2(globalRoot, "plugin", "np")!
    expect(rec.generation).toBe(old.generation + 1)
    expect(rec.version).toBe("2.3.4")
    expect(rec.configKey).toBe("plugin:@alpha/np@2.3.4")
    expect(rec.desiredState).toBe("disabled") // 更新不静默重新启用
    expect(rec.previousDigest).toBe(`sha256:${"c".repeat(64)}`)
    expect(readCapabilityGrant(globalRoot, "plugin--np")?.capabilities?.slice().sort()).toEqual(["engine:config", "engine:plugin"])
  })

  test("同钉版同 digest → 幂等早退(零副作用,warning 说明)", async () => {
    seedNpmOld({ pinned: "@alpha/np@2.3.4", digest: npDigest(), version: "2.3.4" })
    const before = fs.readFileSync(path.join(globalRoot, "installs.json"))
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning).toContain("nothing to replace")
    expect(fs.readFileSync(path.join(globalRoot, "installs.json")).equals(before)).toBe(true)
  })

  test("锁内 precondition 钉 TOCTOU:plan 快照与锁内重读分歧 → 拒绝重试,config/账本零变化", async () => {
    seedNpmOld()
    // 预写授权基线(与请求集同)→ authorize 闸静默通过,单次驱动内演练 plan→锁内窗口。
    writeCapabilityGrantSync(globalRoot, { v: 1, key: "plugin--np", capabilities: ["engine:config", "engine:plugin"], txId: "t-pre", grantedAt: new Date().toISOString() })
    let reads = 0
    const { deps } = makeDeps({
      installers: {
        // 第 1 次(dispatch)与第 2 次(plan 快照)= 原状;第 3 次(锁内 precondition)= 漂移
        //(模拟 plan 与锁获取之间的跨进程/绕道写方)。
        readPluginArrayStrict: () => {
          reads++
          return { ok: true as const, value: reads >= 3 ? ["@alpha/np@2.0.0", "intruder@1.0.0"] : ["@alpha/np@2.0.0"] }
        },
      },
    })
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("changed since plan")
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg.plugin).toEqual(["@alpha/np@2.0.0"]) // 旧元素原样;替换未发生
    expect(findRecordV2(globalRoot, "plugin", "np")!.version).toBe("2.0.0")
  })

  test("双键(entry 名与规范化名各有账)→ 显式拒绝;规范化名单独有账且名不符 → 名变更拒绝", async () => {
    seedNpmOld()
    seedNpmOld({ name: "alpha__np" })
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("duplicate keys")

    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })
    seedNpmOld({ name: "alpha__np" })
    const r2 = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("name changes are refused")
  })

  test("configKey 与实际 config 不符(账/配漂移)→ 拒绝 replace 也拒绝 fresh", async () => {
    seedNpmOld()
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [] }, null, 2)) // 配置已被外力清掉
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("ledger/config drift")
    expect(called(calls, "persistPlugin")).toHaveLength(0)
  })

  test("vendored 替换:versioned staging → 事务切路径 → 旧目录 GC;versioned 目录可正常卸载", async () => {
    // 旧 vendored 安装:plugins/vp + config 路径 + 账。
    const oldDir = path.join(globalRoot, "plugins", "vp")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, "plugin.js"), "// old")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp",
      name: "vp",
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      version: "0.9.0",
      desiredState: "enabled",
      origin: "catalog",
      configKey: `plugin-path:${oldJs}`,
      files: [oldDir],
      transaction: { id: "tx-old-vp", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stagedDir = path.join(globalRoot, "plugins", "vp@feed1234")
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg.plugin).toEqual([path.join(stagedDir, "plugin.js")])
    expect(fs.existsSync(oldDir)).toBe(false) // 旧目录提交成功后 GC
    expect(fs.existsSync(stagedDir)).toBe(true)
    const rec = findRecordV2(globalRoot, "plugin", "vp")!
    expect(rec.configKey).toBe(`plugin-path:${path.join(stagedDir, "plugin.js")}`)
    // versioned 目录卸载(#352 放宽 <name>@<suffix>):
    const u = await uninstallByKey({ type: "plugin", name: "vp", scope: "global" }, deps)
    expect(u.ok).toBe(true)
    expect(fs.existsSync(stagedDir)).toBe(false)
    expect(findRecordV2(globalRoot, "plugin", "vp")).toBeNull()
  })
})

// ── #352 review #381 回归锁 ────────────────────────────────────────────────────────────────────────
describe("plugin replace hardening (review #381)", () => {
  test("vendored:账本路径树外(形状合法但漂移)→ 拒绝 replace,绝不作为删除目标", async () => {
    const evilJs = path.join(tmp, "Documents", "plugin.js")
    fs.mkdirSync(path.dirname(evilJs), { recursive: true })
    fs.writeFileSync(evilJs, "// user data")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [evilJs] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: "0.9.0", desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${evilJs}`, transaction: { id: "tx-evil", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("uncontrolled removal target")
    expect(fs.existsSync(evilJs)).toBe(true) // 树外目标毫发无损
  })

  test("改名史:同 catalog id 的 v1-only 历史名(当前 spec 重建不出)→ 拒绝,不误走 fresh", async () => {
    addReceipt(globalRoot, { id: "plugin:np", name: "old__np", type: "plugin", scope: "global", installedAt: new Date().toISOString(), origin: "catalog", configKey: "plugin:@old/np@1.0.0" })
    const { deps, calls } = makeDeps()
    const r = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("historical package name")
    expect(called(calls, "persistPlugin")).toHaveLength(0)
  })

  test("幂等早退须证完整:同 digest 但 plugin.js 丢失(vendored)→ 走完整替换修复,不谎报成功", async () => {
    const oldDir = path.join(globalRoot, "plugins", "vp")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.mkdirSync(oldDir, { recursive: true }) // 目录在、plugin.js 丢失
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs] }, null, 2))
    const d = decodeManifestV2(synthesizeManifest({ entry: pluginVendoredEntry, channel: "remote", catalogVersion: "2026-07-13.1" }))
    if (!d.ok) throw new Error("fixture manifest invalid")
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: d.manifest.version, manifestDigest: computeManifestDigest(d.manifest),
      desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-old-vp2", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning ?? "").not.toContain("nothing to replace") // 修复路径,非早退
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg.plugin[0]).toContain("vp@feed1234") // 新 versioned 路径已接管
  })

  test("replay:可变归属字段(desiredState)漂移不算冲突 —— 重放保留后到变更;纯重放批零写盘", async () => {
    const base = {
      id: "plugin:np", name: "np", kind: "plugin" as const, environment: "prod" as const,
      scope: { kind: "global" as const }, version: "2.3.4", desiredState: "enabled" as const,
      origin: "catalog" as const, configKey: "plugin:@alpha/np@2.3.4",
      transaction: { id: "tx-rp", state: "committed" as const }, installedAt: "2026-07-16T00:00:00.000Z",
    }
    expect(upsertRecordV2(globalRoot, base).ok).toBe(true)
    // 模拟 setInstallState 后到变更(真实写方:保留 transaction.id,只翻 desiredState)…
    const flipped = setDesiredStateV2(globalRoot, "plugin", "np", "disabled")
    expect(flipped.ok).toBe(true)
    // …随后崩溃恢复重放原 tx(desiredState=enabled 的 journal 模板):不冲突、不回翻、不递增。
    const replay = upsertRecordsV2(globalRoot, [base])
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(replay.records[0]!.desiredState).toBe("disabled") // 后到合法变更保留
    expect(replay.records[0]!.generation).toBe(1) // 不递增(重放非新代)
    // 纯重放批 = 零写盘:账本只读也能成功(root CI 跳过)。
    if (!(typeof process.getuid === "function" && process.getuid() === 0)) {
      fs.chmodSync(globalRoot, 0o555)
      try {
        const ro = upsertRecordsV2(globalRoot, [base])
        expect(ro.ok).toBe(true)
      } finally {
        fs.chmodSync(globalRoot, 0o755)
      }
    }
  })
})

// ── #378 r15:同版本严格实物校验 + 文件系统身份对账的 symlink 别名回归 ─────────────────────────
describe("plugin replace r15 —— 同版本精确校验与别名身份对账", () => {
  const seedVendoredCurrent = (jsContent: string) => {
    const oldDir = path.join(globalRoot, "plugins", "vp")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(oldJs, jsContent)
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs] }, null, 2))
    const d = decodeManifestV2(synthesizeManifest({ entry: pluginVendoredEntry, channel: "remote", catalogVersion: "2026-07-13.1" }))
    if (!d.ok) throw new Error("fixture manifest invalid")
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: d.manifest.version, manifestDigest: computeManifestDigest(d.manifest),
      desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-old-vp3", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    return { oldDir, oldJs }
  }

  test("同 digest + 实物逐字节等值 → 幂等早退零副作用(锁内重读 + 精确校验)", async () => {
    seedVendoredCurrent("// vendored vp (plugins/vp)") // 与 makeDeps 载荷 fake 逐字节一致
    const before = fs.readFileSync(path.join(globalRoot, "installs.json"))
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning).toContain("nothing to replace")
    expect(fs.readFileSync(path.join(globalRoot, "installs.json")).equals(before)).toBe(true)
    expect(fs.existsSync(path.join(globalRoot, "plugins", "vp@feed1234"))).toBe(false) // 未 staging
  })

  test("同 digest 但 plugin.js 内容与载荷不符(截断/篡改)→ 不早退,走修复替换", async () => {
    seedVendoredCurrent("// tampered") // r15 前旧判据 existsSync 会误判健康而空转
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning ?? "").not.toContain("nothing to replace")
    expect(strOf(pluginArrayOnDisk()[0])).toContain("vp@feed1234") // 修好的新 versioned 路径接管
    // r16 Minor:置换 receipt 落 payloadDigest(upsert 整记录替换,缺省会抹掉内容身份)。
    expect(strOf(recOf(findRecordV2(globalRoot, "plugin", "vp")).payloadDigest)).toMatch(/^sha256:/)
  })

  test("r16:plugins/<name> 整目录被换成指向外部等值内容的 symlink → 不判健康,走修复替换", async () => {
    const external = path.join(tmp, "external-vp")
    fs.mkdirSync(external, { recursive: true })
    fs.writeFileSync(path.join(external, "plugin.js"), "// vendored vp (plugins/vp)") // 字节等值也不行
    const oldDir = path.join(globalRoot, "plugins", "vp")
    fs.mkdirSync(path.dirname(oldDir), { recursive: true })
    fs.symlinkSync(external, oldDir)
    const oldJs = path.join(oldDir, "plugin.js")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs] }, null, 2))
    const d = decodeManifestV2(synthesizeManifest({ entry: pluginVendoredEntry, channel: "remote", catalogVersion: "2026-07-13.1" }))
    if (!d.ok) throw new Error("fixture manifest invalid")
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: d.manifest.version, manifestDigest: computeManifestDigest(d.manifest),
      desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-old-vp5", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning ?? "").not.toContain("nothing to replace") // 外部路径执行现场必须被修复
    expect(strOf(pluginArrayOnDisk()[0])).toContain("vp@feed1234")
  })

  test("r16:等值载荷 + 多余空目录夹带 → 不判健康,走修复替换", async () => {
    const { oldDir } = seedVendoredCurrent("// vendored vp (plugins/vp)")
    fs.mkdirSync(path.join(oldDir, "smuggled"), { recursive: true })
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning ?? "").not.toContain("nothing to replace")
  })

  test("r20:vendored 首装遇同包 base 未策展 npm 条目 → 拒(引擎按包名与 file URL 各自去重,两份都会加载)", async () => {
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: ["@alpha/vp@0.9.9"] }, null, 2))
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("refusing to adopt or double-install")
    expect(fs.existsSync(path.join(globalRoot, "plugins", "vp@feed1234"))).toBe(false) // 未 staging
    const cfgAfter = pluginArrayOnDisk()
    expect(cfgAfter).toEqual(["@alpha/vp@0.9.9"]) // 原条目原封
  })

  test("r22:同版本健康 vendored + 同包 npm pin 在场 → 幂等早退失效,如实拒(不谎报 already)", async () => {
    const { oldJs } = seedVendoredCurrent("// vendored vp (plugins/vp)") // 实物逐字节健康
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs, "@alpha/vp@0.9.9"] }, null, 2))
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false) // r22 前:返回 ok + "already at this version",双载现场被报成功
    if (!r.ok) expect(r.reason).toContain("engine loads it alongside")
    expect(pluginArrayOnDisk()).toEqual([oldJs, "@alpha/vp@0.9.9"]) // config 原封交人工清
  })

  test("r21:vendored→vendored 更新遇同包 base 未策展 npm 条目 → 拒且 staging 清净(fresh 门不覆盖 replace)", async () => {
    const oldDir = path.join(globalRoot, "plugins", "vp")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(oldJs, "// old")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [oldJs, "@alpha/vp@0.9.9"] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: "0.9.0", desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-old-vp6", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("engine loads it alongside")
    expect(pluginArrayOnDisk()).toEqual([oldJs, "@alpha/vp@0.9.9"]) // config 原封
    expect(fs.existsSync(path.join(globalRoot, "plugins", "vp@feed1234"))).toBe(false) // staging 已清
  })

  test("r20:npm→vendored 迁移 —— 载荷分支按新 spec 选,npm 钉版被换成 vendored 路径(不再账实背离)", async () => {
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: ["@alpha/vp@0.9.0"] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: "0.9.0", desiredState: "enabled", origin: "catalog",
      configKey: "plugin:@alpha/vp@0.9.0", transaction: { id: "tx-npm-old", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning ?? "").not.toContain("nothing to replace")
    const stagedJs = path.join(globalRoot, "plugins", "vp@feed1234", "plugin.js")
    expect(pluginArrayOnDisk()).toEqual([stagedJs]) // r20 前:继续钉 npm,加载源与 bundled manifest 背离
    const rec = recOf(findRecordV2(globalRoot, "plugin", "vp"))
    expect(rec.configKey).toBe(`plugin-path:${stagedJs}`)
    expect(strOf(rec.payloadDigest)).toMatch(/^sha256:/)
  })

  test("config 条目经 symlink 别名指向账本路径 → 身份对账不误判 drift,置换收敛为单条", async () => {
    const oldDir = path.join(globalRoot, "plugins", "vp")
    const oldJs = path.join(oldDir, "plugin.js")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(oldJs, "// old")
    const aliasRoot = path.join(tmp, "alias-plugins")
    fs.symlinkSync(path.join(globalRoot, "plugins"), aliasRoot)
    const aliasJs = path.join(aliasRoot, "vp", "plugin.js")
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [aliasJs] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:vp", name: "vp", kind: "plugin", environment: "prod", scope: { kind: "global" },
      version: "0.9.0", desiredState: "enabled", origin: "catalog",
      configKey: `plugin-path:${oldJs}`, transaction: { id: "tx-old-vp4", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
    const { deps } = makeDeps()
    const r = await installAuthorized({ catalogId: "plugin:vp", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stagedJs = path.join(globalRoot, "plugins", "vp@feed1234", "plugin.js")
    expect(pluginArrayOnDisk()).toEqual([stagedJs]) // 别名条目被换元,不残留
    expect(recOf(findRecordV2(globalRoot, "plugin", "vp")).configKey).toBe(`plugin-path:${stagedJs}`)
  })
})

// ── #361:catalog agent 走事务安装链(file md + config 叶单事务;裁决见 issue #361 评论)────────────
describe("catalog agent install via transaction engine (REQ-098 #361)", () => {
  const entriesWithAgents = [...ALL_ENTRIES, agentBuiltinEntry, agentRemoteEntry]

  test("builtin:生产入口全链 —— CAS 摄取(自算内容地址)+ file/config 单事务 + 引擎单点落账 + 授权账", async () => {
    const { deps, calls } = makeDeps({ entries: entriesWithAgents })
    const r = await installAuthorized({ catalogId: "agent:helper", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("agent")
    expect(r.name).toBe("helper")
    // 内容经共享 CAS(#303 裁决 B:builtin 自算内容地址),md byte-exact。
    expect(hasCasBlob(path.join(tmp, "cas-base"), crypto.createHash("sha256").update(AGENT_MD).digest("hex"))).toBe(true)
    const mdPath = path.join(globalRoot, "agents", "helper.md")
    expect(fs.readFileSync(mdPath, "utf8")).toBe(AGENT_MD)
    expect(r.files).toContain(mdPath)
    // config 叶与 md 同事务落位(agentMdToEntry 单一真源)。
    const leaf = readAgentLeaf(globalRoot, "helper")
    expect(leaf?.description).toBe("test agent")
    expect(leaf?.prompt).toBe("agent body")
    // 账本单点 = 引擎 commitReceipt(planner 无第二次 upsert):v2 record 带 configKey + builtin payloadDigest。
    const rec = findRecordV2(globalRoot, "agent", "helper")
    expect(rec).not.toBeNull()
    expect(rec!.kind).toBe("agent")
    expect(rec!.origin).toBe("catalog")
    expect(rec!.configKey).toBe("agent.helper")
    expect(rec!.version).toBe("1.0.0")
    // builtin payloadDigest 钉精确值(r2:自算内容地址的聚合,任意字符串不许通过)。
    expect(rec!.payloadDigest).toBe(
      aggregateFilesDigest([
        { path: "helper.md", sha256: crypto.createHash("sha256").update(AGENT_MD).digest("hex"), bytes: Buffer.byteLength(AGENT_MD) },
      ]),
    )
    expect(rec!.manifestDigest).toBe(r.manifestDigest)
    // 授权账落主 item key(config 副 item 不落)。
    expect(readCapabilityGrant(globalRoot, "agent--helper")?.capabilities?.slice().sort()).toEqual(["engine:config", "prompt:context"])
    expect(readCapabilityGrant(globalRoot, "agent--helper--config")).toBeNull()
    // 载荷收集只读可重入(首驱 authorize 暂停 + 确认重驱各一次);事务确实产生了 journal
    // 且全部终态(r2:空列表 every=true 的空通过不算证据)。
    expect(called(calls, "collectBuiltinAgentPayload")).toHaveLength(2)
    const journalProbe = probeTransactionJournals(globalRoot)
    expect(journalProbe.entries.length).toBeGreaterThan(0)
    expect(journalProbe.entries.every((e) => e.terminal)).toBe(true)
  })

  test("remote:authorize 首驱零权威副作用且下载一次;确认重驱 CAS 逐 blob 命中,绝不二次下载", async () => {
    const { deps, calls } = makeDeps({ entries: entriesWithAgents })
    const first = await installCatalog({ catalogId: "agent:remote-agent", scope: { scope: "global" } }, deps)
    expect(first.ok).toBe(false)
    if (first.ok || first.stage !== "authorize") throw new Error("expected authorize pause")
    expect(first.authorization).toHaveLength(1)
    const authzDiff = first.authorization[0]
    if (!authzDiff) throw new Error("unreachable")
    expect(authzDiff.key).toBe("agent--remote-agent")
    expect(authzDiff.requested.slice().sort()).toEqual(["engine:config", "prompt:context"])
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1)
    // 零权威副作用(CAS blob 是可回收缓存,允许残留)。
    expect(fs.existsSync(path.join(globalRoot, "agents", "remote-agent.md"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "remote-agent")).toBeNull()
    const confirmed = Object.fromEntries(first.authorization.map((d) => [d.key, d.requested]))
    const second = await installCatalog({ catalogId: "agent:remote-agent", scope: { scope: "global" }, authorization: { confirmed } }, deps)
    expect(second.ok).toBe(true)
    expect(called(calls, "downloadRemoteAsset")).toHaveLength(1) // 重驱零网络
    expect(fs.readFileSync(path.join(globalRoot, "agents", "remote-agent.md"), "utf8")).toBe(REMOTE_AGENT_MD)
    const rec = findRecordV2(globalRoot, "agent", "remote-agent")
    expect(rec!.payloadDigest).toBe(aggregateFilesDigest(agentRemoteFiles))
  })

  test("身份漂移(id ≠ agent:<name>)与 '--' 名:catalog 边界显式拒(与 seed 同合同),零内容副作用", async () => {
    const drift = { ...agentBuiltinEntry, name: "other" } as CatalogEntry
    const { deps, calls } = makeDeps({ entries: [...ALL_ENTRIES, drift] })
    const r = await installCatalog({ catalogId: "agent:helper", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("identity drift")
    expect(called(calls, "collectBuiltinAgentPayload")).toHaveLength(0)

    const dashed = { ...agentBuiltinEntry, id: "agent:has--dash", name: "has--dash" } as CatalogEntry
    const { deps: d2, calls: c2 } = makeDeps({ entries: [...ALL_ENTRIES, dashed] })
    const r2 = await installCatalog({ catalogId: "agent:has--dash", scope: { scope: "global" } }, d2)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain('"--"')
    expect(called(c2, "collectBuiltinAgentPayload")).toHaveLength(0)
  })

  test("锁内 fresh 门(引擎 precondition):锁外门被绕过(agentPresent=false)仍拒无账 config 叶,引擎回滚零残留", async () => {
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ agent: { helper: { description: "mine", prompt: "p" } } }))
    const { deps } = makeDeps({ entries: entriesWithAgents }) // harness 缺省 agentPresent=false = 锁外门失明
    const r = await installAuthorized({ catalogId: "agent:helper", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('config entry "agent.helper"')
    expect(fs.existsSync(path.join(globalRoot, "agents", "helper.md"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "helper")).toBeNull()
  })

  test("remote 资产多文件 → 装约定拒(恰一顶层 .md),不触达引擎", async () => {
    const extra = "extra-content"
    const twoFiles = [
      ...agentRemoteFiles,
      { path: "extra.md", sha256: crypto.createHash("sha256").update(extra).digest("hex"), bytes: Buffer.byteLength(extra), url: "https://assets.example/extra.md" },
    ]
    const multi = { ...agentRemoteEntry, remoteAsset: { version: "1.1.0", files: twoFiles } } as CatalogEntry
    const { deps } = makeDeps({
      entries: [...ALL_ENTRIES, multi],
      installers: {
        downloadRemoteAsset: async () => ({
          ok: true,
          contents: [
            { path: "remote-agent.md", data: Buffer.from(REMOTE_AGENT_MD) },
            { path: "extra.md", data: Buffer.from(extra) },
          ],
        }),
      },
    })
    const r = await installAuthorized({ catalogId: "agent:remote-agent", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("exactly one file")
    expect(fs.existsSync(path.join(globalRoot, "agents", "remote-agent.md"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "remote-agent")).toBeNull()
  })
})

// ── #397:curation 消费接线(archived 拒装 / activationPolicy 落账 / enable 闸)────────────────────

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
/** 合同-有效的 curation 对象(blob URL 按 (id, version) 逐字推导;不变量:labs⇒session-grant、
 *  default-enabled⇒core 由调用方保证)。 */
const makeCuration = (
  catalogId: string,
  version: string,
  over: Partial<{ tier: string; activationPolicy: string; upstreamStatus: string; reviewedAt: string; reviewBefore: string }> = {},
) => ({
  schema: "alpha.catalog.curation.v1",
  tier: over.tier ?? "precache",
  activationPolicy: over.activationPolicy ?? "default-disabled",
  deliveryMode: "installable",
  review: {
    reviewedAt: over.reviewedAt ?? "2026-07-01T00:00:00Z",
    reviewedBy: "alpha-review",
    upstreamStatus: over.upstreamStatus ?? "active",
    supportTier: "best-effort",
    reviewBefore: over.reviewBefore ?? "2027-07-01T00:00:00Z",
  },
  applicability: { frameworks: ["*"] },
  summaries: {
    capabilities: [],
    networkDomains: [],
    requiredSecrets: [],
    runtimeDependencies: [],
    download: { bytes: null, basis: "unknown" },
  },
  refs: {
    sbom: { sha256: SHA_A, bytes: 1024, url: curationBlobUrl(catalogId, version, "sbom", SHA_A), format: "cyclonedx-1.6+json" },
    intakeProvenance: {
      sha256: SHA_B,
      bytes: 512,
      url: curationBlobUrl(catalogId, version, "intakeProvenance", SHA_B),
      format: "alpha.intake-provenance.v1+json",
    },
  },
})

describe("#397 安装面:archived 拒装 + activationPolicy 声明落账", () => {
  const grants = { secrets: { API_KEY: "s" } }
  const intent = { catalogId: "mcp:markitdown", scope: { scope: "global" }, grants }

  test("upstreamStatus=archived ⇒ 禁新安装(§7.2 纵深);零落账", async () => {
    const archived: CatalogEntry = {
      ...mcpEntry,
      source: "official",
      curation: makeCuration("mcp:markitdown", "1.0.0", { upstreamStatus: "archived" }),
    }
    const { deps } = makeDeps({ entries: [archived] })
    const r = await installAuthorized(intent, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("upstream is archived")
    expect(findRecordV2(globalRoot, "mcp", "markitdown")).toBeNull()
  })

  test("default-enabled(core)声明 > #395 来源分类:official source 也落 enabled", async () => {
    const coreEntry: CatalogEntry = {
      ...mcpEntry,
      source: "official",
      curation: makeCuration("mcp:markitdown", "1.0.0", { tier: "core", activationPolicy: "default-enabled" }),
    }
    const { deps } = makeDeps({ entries: [coreEntry] })
    const r = await installAuthorized(intent, deps)
    expect(r.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("enabled")
  })

  test("session-grant(labs)⇒ 持久账本恒 disabled:alpha source 也不例外", async () => {
    const labsEntry: CatalogEntry = {
      ...mcpEntry,
      source: "alpha",
      curation: makeCuration("mcp:markitdown", "1.0.0", { tier: "labs", activationPolicy: "session-grant" }),
    }
    const { deps } = makeDeps({ entries: [labsEntry] })
    const r = await installAuthorized(intent, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.installedDisabled).toBe(true)
    expect(mcpLeafOnDisk("markitdown")?.enabled).toBe(false)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
  })

  test("复审过期(排他截止):default-enabled 也先落 disabled(启用走显式确认)", async () => {
    const expired: CatalogEntry = {
      ...mcpEntry,
      source: "alpha",
      curation: makeCuration("mcp:markitdown", "1.0.0", { tier: "core", activationPolicy: "default-enabled", reviewedAt: "2025-01-01T00:00:00Z", reviewBefore: "2026-01-01T00:00:00Z" }),
    }
    const { deps } = makeDeps({ entries: [expired] })
    const r = await installAuthorized(intent, deps)
    expect(r.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
  })

  test("r1-2(更新链):已启用 mcp 重装到声明 session-grant 的版本 ⇒ 账本归位 disabled(upsert 的 prev 优先不得复活 enabled)", async () => {
    // 先以未策展 alpha 源装成 enabled(#395 规则)。
    const plainAlpha: CatalogEntry = { ...mcpEntry, source: "alpha" }
    const { deps: deps1 } = makeDeps({ entries: [plainAlpha] })
    expect((await installAuthorized(intent, deps1)).ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("enabled")
    // 目录换代:同 id 版本声明 session-grant → 重装后持久账本必须归位 disabled。
    const labsNow: CatalogEntry = {
      ...mcpEntry,
      source: "alpha",
      curation: makeCuration("mcp:markitdown", "1.0.0", { tier: "labs", activationPolicy: "session-grant" }),
    }
    const { deps: deps2 } = makeDeps({ entries: [labsNow] })
    const r = await installAuthorized(intent, deps2)
    expect(r.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
    expect(mcpLeafOnDisk("markitdown")?.enabled).toBe(false)
  })

  test("curation 校验失败 = fail-closed 到未策展保守面:绝不部分采信(archived 也不作数),按 #395 分类", async () => {
    const invalid: CatalogEntry = {
      ...mcpEntry,
      source: "alpha", // #395 保守面:alpha 源 → enabled(证明走了保守面而非声明面)
      curation: { ...makeCuration("mcp:markitdown", "1.0.0", { upstreamStatus: "archived" }), rogue: true },
    }
    const { deps } = makeDeps({ entries: [invalid] })
    const r = await installAuthorized(intent, deps)
    expect(r.ok).toBe(true) // invalid 的 archived 不拒装(不挑「看起来没坏」的字段用)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("enabled")
  })
})

describe("#397 enable 闸(setInstallStateByKey;advisory 之后)", () => {
  const grants = { secrets: { API_KEY: "s" } }
  const intent = { catalogId: "mcp:markitdown", scope: { scope: "global" }, grants }
  const enableIntent = { type: "mcp", name: "markitdown", scope: "global", state: "enabled" }

  test("session-grant:enable 拒(code 判别);disable 方向不受限", async () => {
    const labsEntry: CatalogEntry = {
      ...mcpEntry,
      source: "alpha",
      curation: makeCuration("mcp:markitdown", "1.0.0", { tier: "labs", activationPolicy: "session-grant" }),
    }
    const { deps } = makeDeps({ entries: [labsEntry] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    const en = await setInstallStateByKey(enableIntent, deps)
    expect(en.ok).toBe(false)
    if (!en.ok) {
      expect(en.code).toBe("session-grant-persistent-enable")
      expect(en.reason).toContain("session-grant")
    }
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
    const dis = await setInstallStateByKey({ ...enableIntent, state: "disabled" }, deps)
    expect(dis.ok).toBe(true)
  })

  test("复审过期:enable 需显式确认(confirmExpiredReview=true 才放行)", async () => {
    const expired: CatalogEntry = {
      ...mcpEntry,
      source: "official",
      curation: makeCuration("mcp:markitdown", "1.0.0", { reviewedAt: "2025-01-01T00:00:00Z", reviewBefore: "2026-01-01T00:00:00Z" }),
    }
    const { deps } = makeDeps({ entries: [expired] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    const refused = await setInstallStateByKey(enableIntent, deps)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe("expired-review-confirmation-required")
    const confirmed = await setInstallStateByKey({ ...enableIntent, confirmExpiredReview: true }, deps)
    expect(confirmed.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("enabled")
  })

  test("锁外/锁内指纹漂移(version 变更)⇒ 拒绝重试(TOCTOU 闭合,必改⑤)", async () => {
    const curated: CatalogEntry = {
      ...mcpEntry,
      source: "official",
      curation: makeCuration("mcp:markitdown", "1.0.0"),
    }
    const { deps } = makeDeps({ entries: [curated] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    // resolveEntry await 期间(锁外冻结后、取锁前)记录被改写(版本漂移)→ 锁内指纹核对必须拒。
    const racing: typeof deps = {
      ...deps,
      resolveEntry: async (id) => {
        const rec = findRecordV2(globalRoot, "mcp", "markitdown")!
        const w = upsertRecordV2(globalRoot, {
          id: rec.id,
          name: rec.name,
          kind: "mcp",
          environment: rec.environment,
          scope: { kind: "global" },
          version: "9.9.9",
          desiredState: rec.desiredState,
          origin: rec.origin,
          configKey: rec.configKey,
          installedAt: rec.installedAt,
        })
        if (!w.ok) throw new Error(w.reason)
        return deps.resolveEntry(id)
      },
    }
    const r = await setInstallStateByKey(enableIntent, racing)
    expect(r.ok).toBe(false)
    // r1-5:锁内以「record vs 已验 entry」身份四元组判定 —— 版本漂移即身份失配,拒绝重试。
    if (!r.ok) expect(r.reason).toContain("identity does not match")
  })

  test("r1-5:catalog 不可得(resolveEntry null)⇒ enable 拒,绝不降格未策展放行", async () => {
    const curated: CatalogEntry = { ...mcpEntry, source: "official", curation: makeCuration("mcp:markitdown", "1.0.0") }
    const { deps } = makeDeps({ entries: [curated] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    const offline: typeof deps = { ...deps, resolveEntry: async () => null }
    const r = await setInstallStateByKey(enableIntent, offline)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not resolvable from the verified catalog")
    // disable 方向不受限(fail-closed 只闸激活)。
    expect((await setInstallStateByKey({ ...enableIntent, state: "disabled" }, offline)).ok).toBe(true)
  })

  test("r1-5:同 ID 异版本(装 1.0.0,目录已是 2.0.0)⇒ enable 拒 —— 不得用 v2 策略放行 v1", async () => {
    const v1: CatalogEntry = { ...mcpEntry, source: "official", curation: makeCuration("mcp:markitdown", "1.0.0") }
    const { deps } = makeDeps({ entries: [v1] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    // 目录换代:同 id 的 v2(策展改 default-enabled 也无济于事 —— 身份失配先拒)。
    const v2: CatalogEntry = {
      ...mcpEntry,
      version: "2.0.0",
      source: "official",
      curation: makeCuration("mcp:markitdown", "2.0.0", { tier: "core", activationPolicy: "default-enabled" }),
    }
    const { deps: deps2 } = makeDeps({ entries: [v2] })
    const r = await setInstallStateByKey(enableIntent, deps2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("identity does not match")
  })

  test("未策展记录:enable 不受新限制(#395 语义不回归)", async () => {
    const plain: CatalogEntry = { ...mcpEntry, source: "official" }
    const { deps } = makeDeps({ entries: [plain] })
    expect((await installAuthorized(intent, deps)).ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("disabled")
    const en = await setInstallStateByKey(enableIntent, deps)
    expect(en.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "markitdown")?.desiredState).toBe("enabled")
  })
})

// ── #397 r1-2:plugin 置换(更新链)经带当前 curation 的分类器 ────────────────────────────────────
describe("#397 r1-2:plugin replace 的 session-grant 强制(更新链不是豁免通道)", () => {
  const seedNpmOldEnabled = () => {
    const pinned = "@alpha/np@2.0.0"
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ plugin: [pinned] }, null, 2))
    const w = upsertRecordV2(globalRoot, {
      id: "plugin:np",
      name: "np",
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      version: "2.0.0",
      desiredState: "enabled",
      origin: "catalog",
      configKey: `plugin:${pinned}`,
      transaction: { id: "tx-old-1", state: "committed" },
      installedAt: "2026-07-15T00:00:00.000Z",
    })
    if (!w.ok) throw new Error(w.reason)
  }

  test("已启用 plugin 更新到声明 session-grant 的版本 ⇒ plugin[] 移除 + 账本 disabled(不留非法 enabled)", async () => {
    seedNpmOldEnabled()
    const sessionGrantV2: CatalogEntry = {
      ...pluginNpmEntry,
      source: "official",
      curation: makeCuration("plugin:np", "2.3.4", { tier: "labs", activationPolicy: "session-grant" }),
    }
    const { deps } = makeDeps({ entries: [sessionGrantV2] })
    const r = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg.plugin).toEqual([]) // 目标版本 session-grant:置换丢旧不加新
    const rec = findRecordV2(globalRoot, "plugin", "np")!
    expect(rec.version).toBe("2.3.4")
    expect(rec.desiredState).toBe("disabled") // 持久 enabled 非法 —— 更新链同样强制
  })

  test("r2:授权暂停零账本副作用 —— 归位只在锁内提交路径发生,拒绝/暂停的操作不动账", async () => {
    seedNpmOldEnabled()
    const sessionGrantV2: CatalogEntry = {
      ...pluginNpmEntry,
      source: "official",
      curation: makeCuration("plugin:np", "2.3.4", { tier: "labs", activationPolicy: "session-grant" }),
    }
    const { deps } = makeDeps({ entries: [sessionGrantV2] })
    // 首驱:无授权基线 → authorize 暂停(引擎顺序 lock → authorize 零写盘 → precondition)。
    const first = await installCatalog({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.stage).toBe("authorize")
    // r2 Major 的核心断言:暂停的操作零账本副作用 —— 非法 enabled 原样保留,config 不动。
    expect(findRecordV2(globalRoot, "plugin", "np")!.desiredState).toBe("enabled")
    expect(findRecordV2(globalRoot, "plugin", "np")!.version).toBe("2.0.0")
    const cfg0 = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg0.plugin).toEqual(["@alpha/np@2.0.0"])
    // 确认重驱:锁内 precondition 归位 + 同一事务提交 → disabled + plugin[] 移除。
    const confirmed = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(confirmed.ok).toBe(true)
    expect(findRecordV2(globalRoot, "plugin", "np")!.desiredState).toBe("disabled")
    const cfg1 = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg1.plugin).toEqual([])
  })

  test("对照:目标版本未策展 ⇒ 置换保留旧 enabled(#352 语义不回归)", async () => {
    seedNpmOldEnabled()
    const { deps } = makeDeps({ entries: [{ ...pluginNpmEntry, source: "official" }] })
    const r = await installAuthorized({ catalogId: "plugin:np", scope: { scope: "global" } }, deps)
    expect(r.ok).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(cfg.plugin).toEqual(["@alpha/np@2.3.4"])
    expect(findRecordV2(globalRoot, "plugin", "np")!.desiredState).toBe("enabled")
  })
})
