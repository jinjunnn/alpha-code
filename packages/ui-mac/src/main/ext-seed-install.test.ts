// REQ-102 #317 —— 选中 seed 安装走共享 CAS 事务物化:
//  · AC1 生产入口 installCatalog(seed 意图)端到端:blob 提升进共享 CAS(≠ 环境根)→ generation
//    事务从 CAS 物化(populateFromCas)→ receipt v2 落账;effective remote/cache catalog 零参与;
//  · AC2 双真源:receipt 语义回表同包 bundled catalog entry,seed lock 与 entry 漂移 fail-closed;
//  · AC3 非 skill 类型 / 非 global scope / 未知意图键显式拒绝;
//  · AC4 CAS blob 缺失/损坏 → 事务 abort,零残留;损坏在店 blob 由 put 自愈(原子替换 + loud)。
// 依赖注入(仓规:零 mock.module);seed/CAS/账本全走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { casBlobPath, hasCasBlob } from "./ext-cas"
import { aggregateFilesDigest, computeManifestDigest, decodeManifestV2 } from "./ext-manifest-v2"
import { findRecordV2, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"
import { resolveLiveGenerationDir } from "./ext-transaction"
import { installSkillGeneration, skillGenerationKey } from "./ext-skill-generations"
import { seedBlobPath, type SeedLock } from "./ext-seed"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  compareVersionsSafe,
  installCatalog,
  setInstallStateByKey,
  synthesizeManifest,
  uninstallByKey,
  type PlannerDeps,
  type PlannerInstallers,
  type VerifiedCatalogEntry,
} from "./ext-install-planner"
import { agentConfigItemKey, agentInstallKey } from "./ext-agent-install"
import { capabilityGrantPath } from "./ext-capability-grants"
import { parse } from "jsonc-parser"

// #348:authorize 闸生效后首装零副作用停在 stage="authorize";按生产同路重驱(确认完整 requested
// 集)。非 authorize 失败原样透传 —— downgrade/损坏账本等 fail-closed 语义不受影响。
async function installAuthorized(intent: unknown, deps: Parameters<typeof installCatalog>[1]): ReturnType<typeof installCatalog> {
  const first = await installCatalog(intent, deps)
  if (first.ok || first.stage !== "authorize") return first
  const confirmed = Object.fromEntries(
    first.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]),
  )
  return installCatalog({ ...(intent as Record<string, unknown>), authorization: { confirmed } }, deps)
}

let tmp: string
let seedDir: string
let casBase: string
let globalRoot: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-seed-install-"))
  seedDir = path.join(tmp, "extension-seed")
  casBase = path.join(tmp, "alpha-base")
  globalRoot = path.join(tmp, "global")
  fs.mkdirSync(seedDir, { recursive: true })
  fs.mkdirSync(globalRoot, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex")

// ── fixtures:合法 seed(lock + blobs)与同包 bundled catalog entry ──────────────────────────────

const CATALOG_VERSION = "2026-07-13.1"
const SKILL_MD = "---\nname: hello\ndescription: seed fixture skill\n---\nseed body"
const USAGE_MD = "# usage\nfrom seed"
const skillFiles = [
  { path: "SKILL.md", content: SKILL_MD },
  { path: "docs/usage.md", content: USAGE_MD },
]

type FileFixture = { path: string; content: string }

function lockFileEntries(files: FileFixture[], opts: { writeBlobs?: boolean } = {}) {
  return [...files]
    .sort((x, y) => (x.path < y.path ? -1 : 1))
    .map((f) => {
      const digest = sha(f.content)
      if (opts.writeBlobs !== false) {
        const blob = seedBlobPath(seedDir, digest)!
        fs.mkdirSync(path.dirname(blob), { recursive: true })
        fs.writeFileSync(blob, f.content)
      }
      return { path: f.path, sha256: digest, bytes: Buffer.byteLength(f.content), url: `https://alphacodeone.com/catalog/assets/hello/${f.path}` }
    })
}

function buildSeed(
  assets: Array<{ id: string; files: FileFixture[]; version?: string }>,
  opts: { writeBlobs?: boolean; catalogVersion?: string } = {},
): SeedLock {
  let total = 0
  const lockAssets = assets.map((a) => {
    const files = lockFileEntries(a.files, opts)
    const bytes = files.reduce((s, f) => s + f.bytes, 0)
    total += bytes
    return {
      id: a.id,
      type: a.id.split(":")[0]!,
      version: a.version ?? "1.0.0",
      license: "MIT",
      source: "alpha",
      redistributable: true as const,
      platforms: ["*"],
      licenseFiles: [],
      bytes,
      files,
    }
  })
  const lock: SeedLock = {
    schema: "alpha.extension-seed.lock.v1",
    channel: "stable",
    catalogVersion: opts.catalogVersion ?? CATALOG_VERSION,
    catalog: {
      sha256: sha("catalog payload"),
      bytes: 59424,
      url: `https://alphacodeone.com/catalog/v1/releases/${CATALOG_VERSION}/catalog.json`,
      sigUrl: `https://alphacodeone.com/catalog/v1/releases/${CATALOG_VERSION}/catalog.json.sig`,
    },
    // 含 linux token:CI(ubuntu)跑本套件时 readPackagedSeed 的 S9 门按真实 process 平台判,
    // fixture 不含 linux 会把整个 seed 拒掉 —— #317 起本文件在 linux CI 恒红,此处修复。
    supportedPlatforms: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"],
    budget: { maxAssetBytes: 16777216, maxTotalBytes: 67108864, maxFilesPerAsset: 512 },
    totalBytes: total,
    assets: lockAssets.sort((x, y) => (x.id < y.id ? -1 : 1)) as SeedLock["assets"],
  }
  fs.writeFileSync(path.join(seedDir, "seed.lock.json"), JSON.stringify(lock))
  return lock
}

// #395:机器面测试用第一方 source(alpha)保持 enabled 投影 —— 默认关策略/disabled 投影有专项测试(ext-install-policy.test / 本文件末尾 #395 块)。
const entryBase = { displayName: "d", description: "d", source: "alpha" as const, category: "test" }

function bundledSkillEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "skill:hello",
    type: "skill",
    name: "hello",
    ...entryBase,
    version: "1.0.0",
    installSpec: { kind: "skill", source: "remote", targetDir: "alpha-skills" },
    remoteAsset: { version: "1.0.0", files: lockFileEntries(skillFiles, { writeBlobs: false }) },
    ...overrides,
  } as CatalogEntry
}

/** cast-free 对象窄化(oxlint no-unsafe-type-assertion:新增代码不引入断言)。 */
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

// ── agent seed fixtures(#358:单顶层 .md,agentMdToEntry 可解析)────────────────────────────────
const AGENT_MD = "---\ndescription: seed fixture agent\nmode: subagent\n---\nlocate the bug"
const AGENT_ENTRY = { description: "seed fixture agent", mode: "subagent", prompt: "locate the bug" }
const agentFiles = [{ path: "bug-triage.md", content: AGENT_MD }]

function bundledAgentEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "agent:bug-triage",
    type: "agent",
    name: "bug-triage",
    ...entryBase,
    version: "1.0.0",
    installSpec: { kind: "agent", source: "remote" },
    remoteAsset: { version: "1.0.0", files: lockFileEntries(agentFiles, { writeBlobs: false }) },
    ...overrides,
  } as CatalogEntry
}

/** seed 路径的完成定义之一:planner installers 一个都不许被触碰。
 *  review #384 r2/r3:对象字面量按 PlannerInstallers 全量成员书写、不 as unknown ——
 *  结构偏差在编辑器/类型感知 lint 层可见(CI 的 tsgo 不含测试文件,tsconfig exclude,
 *  存量债不在本票开线);运行时另加 Proxy 拦截:访问表外成员(接口新增后未同步、或
 *  条件式探测旁路)一律 loud 抛错,不给 undefined 静默通过的机会。 */
function forbiddenInstallers(): PlannerInstallers {
  const forbid = (fn: string) => (): never => {
    throw new Error(`installer ${fn} must not be called on the seed path`)
  }
  const table: PlannerInstallers = {
    // #378:直写 seam(persistMcp/fileifyMcpSecrets/restoreMcpLeaf/persistPlugin/
    // removePluginEntryExact/installVendoredPlugin)已随事务化退役,表随接口同步。
    applyMcpWritePolicy: forbid("applyMcpWritePolicy"),
    mcpSecretRefFor: forbid("mcpSecretRefFor"),
    claimMcpSecretVersionDir: forbid("claimMcpSecretVersionDir"),
    writeMcpSecretVersioned: forbid("writeMcpSecretVersioned"),
    removeMcpSecretVersionDir: forbid("removeMcpSecretVersionDir"),
    gcMcpSecrets: forbid("gcMcpSecrets"),
    legacyMcpRefPaths: forbid("legacyMcpRefPaths"),
    readMcpLeafStrict: forbid("readMcpLeafStrict"),
    removeMcpConfigInLock: forbid("removeMcpConfigInLock"),
    removeMcpSecretsStrict: forbid("removeMcpSecretsStrict"),
    findPluginBaseConflictStrict: forbid("findPluginBaseConflictStrict"),
    readPluginArrayStrict: forbid("readPluginArrayStrict"),
    // #378 r6:legacy XDG 合并视图检查是 seed plugin 路径的**合法只读消费**(同名路径双载门 +
    // 旧目录 GC 引用对账)—— 给良性空 stub 而非 forbid;真实实现归 ext-config(环境派生)。
    readLegacyPluginArrayStrict: () => ({ ok: true, sources: [] }),
    mcpConfigTruthPath: () => path.join(globalRoot, "alpha.jsonc"),
    stageVendoredPluginVersioned: forbid("stageVendoredPluginVersioned"),
    removePlugin: forbid("removePlugin"),
    collectVendoredPluginPayload: forbid("collectVendoredPluginPayload"),
    removePluginPath: forbid("removePluginPath"),
    installBuiltinSkill: forbid("installBuiltinSkill"),
    collectBuiltinSkillPayload: forbid("collectBuiltinSkillPayload"),
    collectBuiltinAgentPayload: forbid("collectBuiltinAgentPayload"),
    installRemoteSkill: forbid("installRemoteSkill"),
    removeFsInstall: forbid("removeFsInstall"),
    agentPresent: forbid("agentPresent"),
    downloadRemoteAsset: forbid("downloadRemoteAsset"),
  }
  return new Proxy(table, {
    get(t, prop) {
      if (typeof prop === "string" && !(prop in t))
        throw new Error(`installer "${prop}" accessed on the seed path but missing from the forbidden table — extend the fixture`)
      return Reflect.get(t, prop)
    },
  })
}

function makeSeedDeps(opts: { bundledEntries?: CatalogEntry[]; bundledVersion?: string; seedDirOverride?: string | null } = {}): PlannerDeps {
  const entries = opts.bundledEntries ?? [bundledSkillEntry()]
  return {
    advisoryGate: () => ({ allowed: true }),
    // seed 分支绝不许咨询 effective remote/cache catalog(可能比随包 seed 新)。
    resolveEntry: async () => {
      throw new Error("effective catalog must not be consulted for seed installs")
    },
    environment: () => "prod",
    platform: () => "darwin",
    globalRoot: () => globalRoot,
    casBaseRoot: () => casBase,
    installers: forbiddenInstallers(),
    seed: {
      seedDir: () => (opts.seedDirOverride !== undefined ? opts.seedDirOverride : seedDir),
      resolveBundledEntry: (catalogId): VerifiedCatalogEntry | null => {
        const entry = entries.find((e) => e.id === catalogId)
        return entry ? { entry, channel: "bundled", catalogVersion: opts.bundledVersion ?? CATALOG_VERSION } : null
      },
    },
  }
}

const seedIntent = { source: "seed", assetId: "skill:hello", scope: { scope: "global" } }

describe("seed install via installCatalog (REQ-102 #317)", () => {
  test("installs a selected skill seed asset through shared-CAS transactional materialization", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    const r = await installAuthorized(seedIntent, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("skill")
    expect(r.name).toBe("hello")

    // 字节真源:blob 落共享 CAS 基根(≠ 环境根 —— 环境隔离),内容按 digest 寻址。
    for (const f of skillFiles) {
      expect(hasCasBlob(casBase, sha(f.content))).toBe(true)
      expect(hasCasBlob(globalRoot, sha(f.content))).toBe(false)
    }

    // 物化事实:generation live dir 内容与 seed 字节一致。
    const live = resolveLiveGenerationDir(globalRoot, skillGenerationKey("hello"))
    expect(live).not.toBeNull()
    expect(fs.readFileSync(path.join(live!, "SKILL.md"), "utf8")).toBe(SKILL_MD)
    expect(fs.readFileSync(path.join(live!, "docs", "usage.md"), "utf8")).toBe(USAGE_MD)

    // receipt 语义回表 bundled entry(AC2):version/payloadDigest/manifestDigest/origin。
    const rec = findRecordV2(globalRoot, "skill", "hello")
    expect(rec).not.toBeNull()
    expect(rec!.version).toBe("1.0.0")
    expect(rec!.origin).toBe("catalog")
    expect(rec!.payloadDigest).toBe(aggregateFilesDigest(lockFileEntries(skillFiles, { writeBlobs: false })))

    // manifestDigest = bundled 交付语义的 manifest 快照(ownership.distributed 如实记 bundled)。
    const synthesized = synthesizeManifest({ entry: bundledSkillEntry(), channel: "bundled", catalogVersion: CATALOG_VERSION }) as Record<string, unknown>
    const decoded = decodeManifestV2({ ...synthesized, ownership: { ...(synthesized.ownership as Record<string, unknown>), distributed: "bundled" } })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(r.manifestDigest).toBe(computeManifestDigest(decoded.manifest))
    expect(rec!.manifestDigest).toBe(r.manifestDigest)
  })

  test("same-version reinstall is idempotent (generation append, no refusal)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    expect((await installAuthorized(seedIntent, deps)).ok).toBe(true)
    const again = await installAuthorized(seedIntent, deps)
    expect(again.ok).toBe(true)
  })

  test("self-heals a corrupted in-store CAS blob on reinstall (put replaces, install still verifies)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    expect((await installAuthorized(seedIntent, deps)).ok).toBe(true)
    const blob = casBlobPath(casBase, sha(SKILL_MD))!
    fs.writeFileSync(blob, "tampered bytes")
    const again = await installAuthorized(seedIntent, deps)
    expect(again.ok).toBe(true)
    expect(fs.readFileSync(blob, "utf8")).toBe(SKILL_MD)
  })

  test("refuses non-global scope (ADR-030 统一收回合同,先于 seed 通道)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installAuthorized({ source: "seed", assetId: "skill:hello", scope: { scope: "project", projectDir: tmp } }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("project-scoped catalog/seed installation is unsupported")
  })

  test("refuses unknown keys / grants / non-seed source on the seed intent form", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    const withGrants = await installAuthorized({ ...seedIntent, grants: {} }, deps)
    expect(withGrants.ok).toBe(false)
    if (!withGrants.ok) expect(withGrants.reason).toContain('unknown key "grants"')
    const badSource = await installAuthorized({ source: "catalog", assetId: "skill:hello", scope: { scope: "global" } }, deps)
    expect(badSource.ok).toBe(false)
    const mixed = await installAuthorized({ ...seedIntent, catalogId: "skill:hello" }, deps)
    expect(mixed.ok).toBe(false)
  })

  test("refuses when the seed channel or packaged seed is unavailable", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const noChannel: PlannerDeps = { ...makeSeedDeps(), seed: undefined }
    const r1 = await installAuthorized(seedIntent, noChannel)
    expect(r1.ok).toBe(false)
    const r2 = await installAuthorized(seedIntent, makeSeedDeps({ seedDirOverride: null }))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("no packaged seed")
  })

  test("refuses a corrupt seed lock (fail closed, loud)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    fs.writeFileSync(path.join(seedDir, "seed.lock.json"), "{ not json")
    const r = await installAuthorized(seedIntent, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("packaged seed rejected")
  })

  test("refuses an asset that is not in the packaged seed", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installAuthorized({ ...seedIntent, assetId: "skill:missing" }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not in packaged seed")
  })

  test("refuses non-installable seed types (bundle/cloud)", async () => {
    buildSeed([
      { id: "bundle:kit", files: [{ path: "kit.md", content: "kit" }] },
      { id: "skill:hello", files: skillFiles },
    ])
    const r = await installAuthorized({ ...seedIntent, assetId: "bundle:kit" }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not installable from seed")
  })

  test("refuses when the bundled catalog has no matching entry (seed/catalog drift)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installAuthorized(seedIntent, makeSeedDeps({ bundledEntries: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not in bundled catalog")
  })

  test("refuses file-manifest drift: missing file, extra file, renamed path, changed bytes", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const files = () => lockFileEntries(skillFiles, { writeBlobs: false })
    const variants: Array<{ label: string; files: ReturnType<typeof files> }> = [
      { label: "missing file", files: files().slice(0, 1) },
      { label: "extra file", files: [...files(), { path: "extra.md", sha256: "e".repeat(64), bytes: 4, url: "https://alphacodeone.com/x" }] },
      { label: "renamed path", files: files().map((f) => (f.path === "docs/usage.md" ? { ...f, path: "docs/renamed.md" } : f)) },
      { label: "changed bytes", files: files().map((f) => (f.path === "SKILL.md" ? { ...f, bytes: f.bytes + 1 } : f)) },
    ]
    for (const v of variants) {
      const r = await installAuthorized(
        seedIntent,
        makeSeedDeps({ bundledEntries: [bundledSkillEntry({ remoteAsset: { version: "1.0.0", files: v.files } })] }),
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("drift")
    }
  })

  test("refuses catalogVersion / version / file-digest drift between seed lock and bundled entry", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const catVer = await installAuthorized(seedIntent, makeSeedDeps({ bundledVersion: "2026-07-14.1" }))
    expect(catVer.ok).toBe(false)
    if (!catVer.ok) expect(catVer.reason).toContain("catalogVersion")

    const verDrift = await installAuthorized(seedIntent, makeSeedDeps({ bundledEntries: [bundledSkillEntry({ version: "1.0.1" })] }))
    expect(verDrift.ok).toBe(false)
    if (!verDrift.ok) expect(verDrift.reason).toContain("drift")

    const driftedFiles = lockFileEntries(skillFiles, { writeBlobs: false }).map((f) =>
      f.path === "SKILL.md" ? { ...f, sha256: "d".repeat(64) } : f,
    )
    const shaDrift = await installAuthorized(
      seedIntent,
      makeSeedDeps({ bundledEntries: [bundledSkillEntry({ remoteAsset: { version: "1.0.0", files: driftedFiles } })] }),
    )
    expect(shaDrift.ok).toBe(false)
    if (!shaDrift.ok) expect(shaDrift.reason).toContain("sha256 mismatch")
  })

  test("refuses downgrade over a newer installed version, and refuses incomparable versions", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const installed: UpsertInput = {
      id: "skill:hello",
      name: "hello",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      version: "2.0.0",
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, installed).ok).toBe(true)
    const down = await installAuthorized(seedIntent, makeSeedDeps())
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.reason).toContain("refusing downgrade")

    expect(upsertRecordV2(globalRoot, { ...installed, version: "weird-tag" }).ok).toBe(true)
    const weird = await installAuthorized(seedIntent, makeSeedDeps())
    expect(weird.ok).toBe(false)
    if (!weird.ok) expect(weird.reason).toContain("not comparable")
  })

  test("refuses when an install record exists without a version (fail closed, not fall-through)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const noVersion: UpsertInput = {
      id: "skill:hello",
      name: "hello",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, noVersion).ok).toBe(true)
    const r = await installAuthorized(seedIntent, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no recorded version")
  })

  test("refuses when the target v2 record is corrupt or the ledger file is unreadable", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    expect((await installAuthorized(seedIntent, deps)).ok).toBe(true)

    // 损坏目标 record(schemaVersion 变异 → decode 拒 → corrupt-match):seed 重装必须拒,不得借机重建。
    const ledger = path.join(globalRoot, "installs.json")
    const parsed = JSON.parse(fs.readFileSync(ledger, "utf8")) as Record<string, unknown>
    for (const v of Object.values(parsed)) {
      if (!Array.isArray(v)) continue
      for (const rec of v) {
        if (rec && typeof rec === "object" && (rec as Record<string, unknown>).kind === "skill" && (rec as Record<string, unknown>).name === "hello")
          (rec as Record<string, unknown>).schemaVersion = 99
      }
    }
    fs.writeFileSync(ledger, JSON.stringify(parsed))
    const corruptRecord = await installAuthorized(seedIntent, deps)
    expect(corruptRecord.ok).toBe(false)
    if (!corruptRecord.ok) expect(corruptRecord.reason).toContain("refusing seed install")

    // 账本文件级损坏:同样 fail-closed。
    fs.writeFileSync(ledger, "{ not json")
    const corruptLedger = await installAuthorized(seedIntent, deps)
    expect(corruptLedger.ok).toBe(false)
    if (!corruptLedger.ok) expect(corruptLedger.reason).toContain("refusing seed install")
  })
})

describe("compareVersionsSafe (REQ-102 #317 · Codex review #360)", () => {
  test("compares big segments exactly (no Number precision loss)", () => {
    expect(compareVersionsSafe("1.9007199254740993.0", "1.9007199254740992.0")).toBe(1)
    expect(compareVersionsSafe("1.9007199254740992.0", "1.9007199254740993.0")).toBe(-1)
    expect(compareVersionsSafe("2.0.0", "10.0.0")).toBe(-1)
    expect(compareVersionsSafe("1.2.3", "1.2.3")).toBe(0)
  })
  test("refuses leading zeros, wrong arity and non-numeric segments", () => {
    expect(compareVersionsSafe("1.01.0", "1.1.0")).toBeNull()
    expect(compareVersionsSafe("01.0.0", "1.0.0")).toBeNull()
    expect(compareVersionsSafe("1.0", "1.0.0")).toBeNull()
    expect(compareVersionsSafe("1.0.0.0", "1.0.0")).toBeNull()
    expect(compareVersionsSafe("1.a.0", "1.0.0")).toBeNull()
    expect(compareVersionsSafe("", "1.0.0")).toBeNull()
  })
})

describe("installSkillGeneration CAS content source (REQ-102 #317)", () => {
  const baseSpec = {
    name: "hello",
    id: "skill:hello",
    environment: "prod" as const,
    scope: { kind: "global" as const },
    origin: "catalog" as const,
  }
  const specsFor = (files: FileFixture[]) => files.map((f) => ({ path: f.path, sha256: sha(f.content), size: Buffer.byteLength(f.content) }))

  test("refuses a missing content source (CAS-only: casFiles is the sole channel)", async () => {
    const neither = await installSkillGeneration(globalRoot, { ...baseSpec } as never)
    expect(neither.ok).toBe(false)
    if (!neither.ok) expect(neither.reason).toContain("invalid casFiles")
  })

  test("aborts the transaction when a CAS blob is missing — no generation, no receipt", async () => {
    const r = await installSkillGeneration(globalRoot, {
      ...baseSpec,
      casFiles: { specs: specsFor(skillFiles), casBaseRoot: casBase },
    })
    expect(r.ok).toBe(false)
    expect(resolveLiveGenerationDir(globalRoot, skillGenerationKey("hello"))).toBeNull()
    expect(findRecordV2(globalRoot, "skill", "hello")).toBeNull()
  })

  test("refuses malformed casFiles shapes with a structured failure (no uncaught throw)", async () => {
    const asNever = (v: unknown) => v as never
    const nullCas = await installSkillGeneration(globalRoot, asNever({ ...baseSpec, casFiles: null }))
    expect(nullCas.ok).toBe(false)
    if (!nullCas.ok) expect(nullCas.reason).toContain("invalid casFiles")
    const noSpecs = await installSkillGeneration(globalRoot, asNever({ ...baseSpec, casFiles: { casBaseRoot: casBase } }))
    expect(noSpecs.ok).toBe(false)
    const relRoot = await installSkillGeneration(globalRoot, asNever({ ...baseSpec, casFiles: { specs: specsFor(skillFiles), casBaseRoot: "rel/root" } }))
    expect(relRoot.ok).toBe(false)
  })

  test("runs the precondition inside the bundle lock; refusal leaves zero residue", async () => {
    // 先把合法 blob 放进店(precondition 拒绝发生在 populate 之前,但 casFiles 必须结构合法)。
    for (const f of skillFiles) {
      const data = Buffer.from(f.content)
      fs.mkdirSync(path.dirname(casBlobPath(casBase, sha(f.content))!), { recursive: true })
      fs.writeFileSync(casBlobPath(casBase, sha(f.content))!, data)
    }
    let lockHeldDuringPrecondition: boolean | null = null
    const r = await installSkillGeneration(globalRoot, {
      ...baseSpec,
      casFiles: { specs: specsFor(skillFiles), casBaseRoot: casBase },
      precondition: () => {
        const attempt = tryAcquireBundleLock(globalRoot, { txId: "probe" })
        lockHeldDuringPrecondition = !attempt.ok
        if (attempt.ok) attempt.lock.release()
        return { ok: false, reason: "refused by test precondition" }
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("refused by test precondition")
      expect(r.stage).toBe("precondition")
    }
    expect(lockHeldDuringPrecondition).toBe(true)
    // 零副作用:无 generation、无 receipt、无 journal/staging 残留(precondition 在任何写盘之前)。
    expect(resolveLiveGenerationDir(globalRoot, skillGenerationKey("hello"))).toBeNull()
    expect(findRecordV2(globalRoot, "skill", "hello")).toBeNull()
    const store = path.join(globalRoot, "ext-store", skillGenerationKey("hello"))
    expect(fs.existsSync(store)).toBe(false)
  })

  test("aborts when an in-store CAS blob fails read-back verification (tampered)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    // 先把合法 blob 放进店,再篡改其中一个 —— populate 读取重验必须拒(fail closed)。
    for (const f of skillFiles) {
      const src = seedBlobPath(seedDir, sha(f.content))!
      const dest = casBlobPath(casBase, sha(f.content))!
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }
    fs.writeFileSync(casBlobPath(casBase, sha(SKILL_MD))!, "tampered")
    const r = await installSkillGeneration(globalRoot, {
      ...baseSpec,
      casFiles: { specs: specsFor(skillFiles), casBaseRoot: casBase },
    })
    expect(r.ok).toBe(false)
    expect(resolveLiveGenerationDir(globalRoot, skillGenerationKey("hello"))).toBeNull()
    expect(findRecordV2(globalRoot, "skill", "hello")).toBeNull()
  })
})

// ── #358:agent seed 走事务安装链(file md + config 叶单事务;裁决见 issue #358 评论)──────────────
const agentSeedIntent = { source: "seed", assetId: "agent:bug-triage", scope: { scope: "global" } }
const agentDeps = () => makeSeedDeps({ bundledEntries: [bundledAgentEntry(), bundledSkillEntry()] })

describe("agent seed install via installCatalog (REQ-102 #358)", () => {
  test("installs the agent seed asset through the transactional install chain", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }, { id: "skill:hello", files: skillFiles }])
    const r = await installAuthorized(agentSeedIntent, agentDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("agent")
    expect(r.name).toBe("bug-triage")

    // 字节真源:blob 落共享 CAS 基根;md 落 <root>/agents/<name>.md,内容 byte-exact(不归一行尾)。
    expect(hasCasBlob(casBase, sha(AGENT_MD))).toBe(true)
    const mdPath = path.join(globalRoot, "agents", "bug-triage.md")
    expect(fs.readFileSync(mdPath, "utf8")).toBe(AGENT_MD)

    // config 叶与 md 同事务落位:agent.<name> 严格等于 agentMdToEntry 解析结果。
    const cfg: unknown = parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    if (!isRec(cfg) || !isRec(cfg.agent)) throw new Error("alpha.jsonc missing agent map")
    expect(cfg.agent["bug-triage"]).toEqual(AGENT_ENTRY)

    // receipt 语义回表 bundled entry:kind/version/origin/configKey/files/payloadDigest。
    const rec = findRecordV2(globalRoot, "agent", "bug-triage")
    expect(rec).not.toBeNull()
    expect(rec!.kind).toBe("agent")
    expect(rec!.version).toBe("1.0.0")
    expect(rec!.origin).toBe("catalog")
    expect(rec!.configKey).toBe("agent.bug-triage")
    expect(rec!.files).toContain(mdPath)
    expect(rec!.payloadDigest).toBe(aggregateFilesDigest(lockFileEntries(agentFiles, { writeBlobs: false })))

    // manifestDigest = bundled 交付语义的 manifest 快照(distributed 如实记 bundled)。
    const synthesized: unknown = synthesizeManifest({ entry: bundledAgentEntry(), channel: "bundled", catalogVersion: CATALOG_VERSION })
    if (!isRec(synthesized) || !isRec(synthesized.ownership)) throw new Error("synthesized manifest malformed")
    const decoded = decodeManifestV2({ ...synthesized, ownership: { ...synthesized.ownership, distributed: "bundled" } })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(r.manifestDigest).toBe(computeManifestDigest(decoded.manifest))
    expect(rec!.manifestDigest).toBe(r.manifestDigest)

    // 授权账落主 item key(committed 后才写);config 副 item 未声明 capabilities → 零授权账
    // (review Minor:未参与授权 ≠ 已授权空集)。
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentInstallKey("bug-triage")))).toBe(true)
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentConfigItemKey("bug-triage")))).toBe(false)
  })

  test("首装零副作用停在 authorize;未声明 capabilities 的 config 副 item 不参与授权(单 diff)", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    const first = await installCatalog(agentSeedIntent, agentDeps())
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBe("authorize")
    if (first.stage !== "authorize") throw new Error("unreachable")
    // review Minor:一个逻辑扩展一个授权 key —— config 副 item 不出现在 diff 里。
    expect(first.authorization).toHaveLength(1)
    const main = first.authorization[0]
    expect(main.key).toBe(agentInstallKey("bug-triage"))
    expect(main.requested).toEqual(["engine:config", "prompt:context"])
    expect(main.previous).toBeNull()
    expect(main.requiresConfirmation).toBe(true)
    // 零权威副作用:无 md、无 config 叶、无账、无授权账。
    expect(fs.existsSync(path.join(globalRoot, "agents", "bug-triage.md"))).toBe(false)
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "bug-triage")).toBeNull()
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentInstallKey("bug-triage")))).toBe(false)
  })

  test("fresh-only(锁内 precondition):有账 / 无账 md / 无账 config 叶在场一律拒", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    // A:已有 v2 record。
    const installed: UpsertInput = {
      id: "agent:bug-triage",
      name: "bug-triage",
      kind: "agent",
      environment: "prod",
      scope: { kind: "global" },
      version: "1.0.0",
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, installed).ok).toBe(true)
    const withRecord = await installAuthorized(agentSeedIntent, agentDeps())
    expect(withRecord.ok).toBe(false)
    if (!withRecord.ok) expect(withRecord.reason).toContain("already present")
    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })

    // B:无账 md 在场(未策展内容不认领)。
    fs.mkdirSync(path.join(globalRoot, "agents"), { recursive: true })
    fs.writeFileSync(path.join(globalRoot, "agents", "bug-triage.md"), "---\ndescription: local\n---\nmine")
    const withMd = await installAuthorized(agentSeedIntent, agentDeps())
    expect(withMd.ok).toBe(false)
    if (!withMd.ok) expect(withMd.reason).toContain("without a ledger record")
    fs.rmSync(path.join(globalRoot, "agents", "bug-triage.md"), { force: true })

    // C:无账 config 叶在场。
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ agent: { "bug-triage": { description: "x", prompt: "y" } } }))
    const withLeaf = await installAuthorized(agentSeedIntent, agentDeps())
    expect(withLeaf.ok).toBe(false)
    if (!withLeaf.ok) expect(withLeaf.reason).toContain('config entry "agent.bug-triage"')
  })

  test("形状异常的合法 jsonc(agent 段非对象 / 根非对象)fail-closed,锁正常释放(review Major 5)", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    // agent 段是字符串 —— 若放行到 jsonc modify 会抛异常且不释放引擎锁。
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ agent: "mine" }))
    const strShape = await installAuthorized(agentSeedIntent, agentDeps())
    expect(strShape.ok).toBe(false)
    if (!strShape.ok) expect(strShape.reason).toContain('"agent" section is not an object')

    // 根是数组。
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), "[]")
    const arrRoot = await installAuthorized(agentSeedIntent, agentDeps())
    expect(arrRoot.ok).toBe(false)
    if (!arrRoot.ok) expect(arrRoot.reason).toContain("root is not an object")

    // 锁已释放:恢复 config 后同一 deps 可正常安装(若锁泄漏这里会 busy)。
    fs.rmSync(path.join(globalRoot, "alpha.jsonc"), { force: true })
    const ok = await installAuthorized(agentSeedIntent, agentDeps())
    expect(ok.ok).toBe(true)
  })

  test("refuses agent names containing '--' (transaction key scheme ambiguity, review r2)", async () => {
    const files = [{ path: "foo.md", content: AGENT_MD }]
    buildSeed([{ id: "agent:foo--config", files }])
    const r = await installAuthorized(
      { source: "seed", assetId: "agent:foo--config", scope: { scope: "global" } },
      makeSeedDeps({
        bundledEntries: [
          bundledAgentEntry({ id: "agent:foo--config", name: "foo--config", remoteAsset: { version: "1.0.0", files: lockFileEntries(files, { writeBlobs: false }) } }),
        ],
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('"--"')
  })

  test("refuses identity drift between entry id and entry name", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    const r = await installAuthorized(agentSeedIntent, makeSeedDeps({ bundledEntries: [bundledAgentEntry({ name: "other" })] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("identity drift")
  })

  test("refuses multi-file / non-md / unparsable agent seed assets (fail closed, zero residue)", async () => {
    // 多文件:双真源一致地声明两个文件 → 走到 agent 装约定门再拒。
    const twoFiles = [...agentFiles, { path: "extra.md", content: "extra" }]
    buildSeed([{ id: "agent:bug-triage", files: twoFiles }])
    const multi = await installAuthorized(
      agentSeedIntent,
      makeSeedDeps({ bundledEntries: [bundledAgentEntry({ remoteAsset: { version: "1.0.0", files: lockFileEntries(twoFiles, { writeBlobs: false }) } })] }),
    )
    expect(multi.ok).toBe(false)
    if (!multi.ok) expect(multi.reason).toContain("exactly one file")

    // 非 .md。
    const txtFiles = [{ path: "bug-triage.txt", content: AGENT_MD }]
    buildSeed([{ id: "agent:bug-triage", files: txtFiles }])
    const txt = await installAuthorized(
      agentSeedIntent,
      makeSeedDeps({ bundledEntries: [bundledAgentEntry({ remoteAsset: { version: "1.0.0", files: lockFileEntries(txtFiles, { writeBlobs: false }) } })] }),
    )
    expect(txt.ok).toBe(false)
    if (!txt.ok) expect(txt.reason).toContain("top-level .md")

    // frontmatter 不可解析(agentMdToEntry fail-closed,不装出字段静默丢失的 agent)。
    const badFiles = [{ path: "bug-triage.md", content: "no frontmatter at all" }]
    buildSeed([{ id: "agent:bug-triage", files: badFiles }])
    const bad = await installAuthorized(
      agentSeedIntent,
      makeSeedDeps({ bundledEntries: [bundledAgentEntry({ remoteAsset: { version: "1.0.0", files: lockFileEntries(badFiles, { writeBlobs: false }) } })] }),
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain("not convertible")
    // 零残留:无 md、无账。
    expect(fs.existsSync(path.join(globalRoot, "agents", "bug-triage.md"))).toBe(false)
    expect(findRecordV2(globalRoot, "agent", "bug-triage")).toBeNull()
  })

  test("refuses an oversized agent md (256KB cap, install convention)", async () => {
    const bigFiles = [{ path: "bug-triage.md", content: `---\ndescription: big\n---\n${"x".repeat(256 * 1024)}` }]
    buildSeed([{ id: "agent:bug-triage", files: bigFiles }])
    const r = await installAuthorized(
      agentSeedIntent,
      makeSeedDeps({ bundledEntries: [bundledAgentEntry({ remoteAsset: { version: "1.0.0", files: lockFileEntries(bigFiles, { writeBlobs: false }) } })] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("过大")
  })

  test("uninstall 清除 md/config/账本/授权账;重装重新弹 authorize(#348 合同)", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    const deps = agentDeps()
    expect((await installAuthorized(agentSeedIntent, deps)).ok).toBe(true)
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentInstallKey("bug-triage")))).toBe(true)

    // 测试代:真 removeFsInstall 行为(删 md + 清条目)已有自己的测试;此处专测 planner 的
    // 授权账清理与账本删除编排。
    const installers: PlannerInstallers = {
      ...forbiddenInstallers(),
      removeFsInstall: (_type, name) => {
        fs.rmSync(path.join(globalRoot, "agents", `${name}.md`), { force: true })
        fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), "{}\n")
        return { ok: true, files: [] }
      },
    }
    const uninstallDeps: PlannerDeps = { ...deps, installers }
    const un = await uninstallByKey({ type: "agent", name: "bug-triage", scope: "global" }, uninstallDeps)
    expect(un.ok).toBe(true)
    expect(findRecordV2(globalRoot, "agent", "bug-triage")).toBeNull()
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentInstallKey("bug-triage")))).toBe(false)
    expect(fs.existsSync(capabilityGrantPath(globalRoot, agentConfigItemKey("bug-triage")))).toBe(false)

    // 重装必须重新确认(残留 grant = 静默继承,违反 #348)。
    const again = await installCatalog(agentSeedIntent, deps)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.stage).toBe("authorize")
  })

  test("grant 删除失败 = 卸载失败且账本不动,修复后重试收敛(review Major 4)", async () => {
    buildSeed([{ id: "agent:bug-triage", files: agentFiles }])
    const deps = agentDeps()
    expect((await installAuthorized(agentSeedIntent, deps)).ok).toBe(true)

    const installers: PlannerInstallers = {
      ...forbiddenInstallers(),
      removeFsInstall: (_type, name) => {
        fs.rmSync(path.join(globalRoot, "agents", `${name}.md`), { force: true })
        fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), "{}\n")
        return { ok: true, files: [] }
      },
    }
    const uninstallDeps: PlannerDeps = { ...deps, installers }

    // 把 grants.json 换成非空目录 → unlink 必失败。
    const grantFile = capabilityGrantPath(globalRoot, agentInstallKey("bug-triage"))
    fs.rmSync(grantFile, { force: true })
    fs.mkdirSync(path.join(grantFile, "block"), { recursive: true })

    const blocked = await uninstallByKey({ type: "agent", name: "bug-triage", scope: "global" }, uninstallDeps)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain("grant removal failed")
    // 账本不动 → 可重试,不谎报完成。
    expect(findRecordV2(globalRoot, "agent", "bug-triage")).not.toBeNull()

    // 修复(移除占位目录)后重试收敛。
    fs.rmSync(grantFile, { recursive: true, force: true })
    const retry = await uninstallByKey({ type: "agent", name: "bug-triage", scope: "global" }, uninstallDeps)
    expect(retry.ok).toBe(true)
    expect(findRecordV2(globalRoot, "agent", "bug-triage")).toBeNull()
  })
})

// ── #359:mcp seed 走 config 适配事务(裁决见 issue #359 评论)──────────────────────────────────
const MCP_FILES = [{ path: "server-info.md", content: "# demo mcp — offline carry bytes (not a runtime payload)" }]

function bundledMcpEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "mcp:demo",
    type: "mcp",
    name: "demo",
    ...entryBase,
    version: "1.0.0",
    installSpec: { kind: "mcp", mcpType: "local", command: ["npx", "-y", "demo-mcp"] },
    remoteAsset: { version: "1.0.0", files: lockFileEntries(MCP_FILES, { writeBlobs: false }) },
    ...overrides,
  } as CatalogEntry
}
const mcpSeedIntent = { source: "seed", assetId: "mcp:demo", scope: { scope: "global" } }
const mcpDeps = (overrides: Partial<CatalogEntry> = {}) => makeSeedDeps({ bundledEntries: [bundledMcpEntry(overrides)] })
const readCfg = (): Record<string, unknown> => {
  const cfg: unknown = parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
  if (!isRec(cfg)) throw new Error("config root not an object")
  return cfg
}

describe("mcp seed install via installCatalog (REQ-102 #359)", () => {
  const EXPECTED_MCP = { type: "local", command: ["npx", "-y", "demo-mcp"] }

  test("installs the mcp seed asset as a config-action transaction (liveMcp returned)", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const r = await installAuthorized(mcpSeedIntent, mcpDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("mcp")
    expect(r.liveMcp).toEqual({ name: "demo", config: EXPECTED_MCP })
    // config 叶 = installSpec 派生语义(CAS blob 只是离线携带字节)。
    const mcpMap = readCfg().mcp
    if (!isRec(mcpMap)) throw new Error("mcp section missing")
    expect(mcpMap["demo"]).toEqual(EXPECTED_MCP)
    expect(hasCasBlob(casBase, sha(MCP_FILES[0].content))).toBe(true)
    const rec = findRecordV2(globalRoot, "mcp", "demo")
    expect(rec).not.toBeNull()
    expect(rec!.configKey).toBe("mcp.demo")
    expect(rec!.version).toBe("1.0.0")
    expect(rec!.payloadDigest).toBe(aggregateFilesDigest(lockFileEntries(MCP_FILES, { writeBlobs: false })))
    expect(fs.existsSync(capabilityGrantPath(globalRoot, "mcp--demo"))).toBe(true)
  })

  test("首装停在 authorize(requested = 严格解码 manifest 能力集),零权威副作用", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const first = await installCatalog(mcpSeedIntent, mcpDeps())
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBe("authorize")
    if (first.stage !== "authorize") throw new Error("unreachable")
    expect(first.authorization).toHaveLength(1)
    expect(first.authorization[0].key).toBe("mcp--demo")
    expect(first.authorization[0].requested).toEqual(["engine:config", "process:spawn"])
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "mcp", "demo")).toBeNull()
  })

  test("phase-1 fail-closed:secret-bearing / workspace / Excel 一律拒(seed intent 无 grants 通道)", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const secret = await installAuthorized(mcpSeedIntent, mcpDeps({ installSpec: { kind: "mcp", mcpType: "local", command: ["npx", "x"], requiredEnvVars: ["API_KEY"] } }))
    expect(secret.ok).toBe(false)
    if (!secret.ok) expect(secret.reason).toContain("secret-bearing")

    const ws = await installAuthorized(mcpSeedIntent, mcpDeps({ installSpec: { kind: "mcp", mcpType: "local", command: ["npx", "{workspace}/x"] } }))
    expect(ws.ok).toBe(false)
    if (!ws.ok) expect(ws.reason).toContain("workspace")

    const excelFiles = [{ path: "x.md", content: "excel" }]
    buildSeed([{ id: "mcp:excel-mcp-server", files: excelFiles }])
    const excel = await installAuthorized(
      { source: "seed", assetId: "mcp:excel-mcp-server", scope: { scope: "global" } },
      makeSeedDeps({
        bundledEntries: [
          bundledMcpEntry({ id: "mcp:excel-mcp-server", name: "excel-mcp-server", remoteAsset: { version: "1.0.0", files: lockFileEntries(excelFiles, { writeBlobs: false }) } }),
        ],
      }),
    )
    expect(excel.ok).toBe(false)
    if (!excel.ok) expect(excel.reason).toContain("Excel")
  })

  test("纯 validator 在 plan 生成前拦危险配置(inline-eval / 非白名单命令头)", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const evalFlag = await installAuthorized(mcpSeedIntent, mcpDeps({ installSpec: { kind: "mcp", mcpType: "local", command: ["node", "-e", "evil()"] } }))
    expect(evalFlag.ok).toBe(false)
    if (!evalFlag.ok) expect(evalFlag.reason).toContain("failed validation")
    const badHead = await installAuthorized(mcpSeedIntent, mcpDeps({ installSpec: { kind: "mcp", mcpType: "local", command: ["rm", "-rf", "/"] } }))
    expect(badHead.ok).toBe(false)
    if (!badHead.ok) expect(badHead.reason).toContain("failed validation")
    // 零副作用:config 未创建。
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
  })

  test("锁内门:无账 config 叶拒认领;downgrade 拒;同版本重装幂等", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    // 无账叶。
    fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), JSON.stringify({ mcp: { demo: { type: "local", command: ["npx", "mine"] } } }))
    const unregistered = await installAuthorized(mcpSeedIntent, mcpDeps())
    expect(unregistered.ok).toBe(false)
    if (!unregistered.ok) expect(unregistered.reason).toContain("without a ledger record")
    fs.rmSync(path.join(globalRoot, "alpha.jsonc"), { force: true })

    // downgrade。
    const newer: UpsertInput = {
      id: "mcp:demo",
      name: "demo",
      kind: "mcp",
      environment: "prod",
      scope: { kind: "global" },
      version: "2.0.0",
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, newer).ok).toBe(true)
    const down = await installAuthorized(mcpSeedIntent, mcpDeps())
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.reason).toContain("refusing downgrade")
    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })

    // 同版本重装幂等(先正常装一次,再装一次)。
    expect((await installAuthorized(mcpSeedIntent, mcpDeps())).ok).toBe(true)
    expect((await installAuthorized(mcpSeedIntent, mcpDeps())).ok).toBe(true)
  })

  test("journaled 卸载联动清授权账,重装重新弹 authorize", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const deps = mcpDeps()
    expect((await installAuthorized(mcpSeedIntent, deps)).ok).toBe(true)
    expect(fs.existsSync(capabilityGrantPath(globalRoot, "mcp--demo"))).toBe(true)

    const installers: PlannerInstallers = {
      ...forbiddenInstallers(),
      removeMcpConfigInLock: (_name) => {
        fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), "{}\n")
        return { ok: true }
      },
      removeMcpSecretsStrict: (_name) => ({ ok: true }),
    }
    const un = await uninstallByKey({ type: "mcp", name: "demo", scope: "global" }, { ...deps, installers })
    expect(un.ok).toBe(true)
    expect(findRecordV2(globalRoot, "mcp", "demo")).toBeNull()
    expect(fs.existsSync(capabilityGrantPath(globalRoot, "mcp--demo"))).toBe(false)
    const again = await installCatalog(mcpSeedIntent, deps)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.stage).toBe("authorize")
  })
})

// ── #359:plugin seed 走确定性 CAS staging + config 事务(接 #352 三态)────────────────────────────
const PLUGIN_FILES = [
  { path: "plugin.js", content: "export const Demo = async () => ({})" },
  { path: "lib/util.js", content: "export const u = 1" },
]
const PLUGIN_FILES_V2 = [
  { path: "plugin.js", content: "export const Demo = async () => ({ v: 2 })" },
  { path: "lib/util.js", content: "export const u = 2" },
]

function bundledPluginEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "plugin:demo-plugin",
    type: "plugin",
    name: "demo-plugin",
    ...entryBase,
    version: "1.0.0",
    installSpec: { kind: "plugin", vendoredAssetKey: "seed-demo-plugin" },
    remoteAsset: { version: "1.0.0", files: lockFileEntries(PLUGIN_FILES, { writeBlobs: false }) },
    ...overrides,
  } as CatalogEntry
}
const pluginSeedIntent = { source: "seed", assetId: "plugin:demo-plugin", scope: { scope: "global" } }
const pluginDeps = (overrides: Partial<CatalogEntry> = {}) => makeSeedDeps({ bundledEntries: [bundledPluginEntry(overrides)] })
// 目录名 = payloadDigest 剥 `sha256:` 前缀后前 16 hex(review #383:带前缀切片只剩 20 bit 且含 `:`)。
const pluginDigest16 = (files: FileFixture[]) => aggregateFilesDigest(lockFileEntries(files, { writeBlobs: false })).replace(/^sha256:/, "").slice(0, 16)

describe("plugin seed install via installCatalog (REQ-102 #359)", () => {
  test("fresh:确定性内容寻址目录 + config 事务 + 账本/授权账落位", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const r = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("plugin")
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    expect(r.files).toEqual([dir])
    expect(fs.readFileSync(path.join(dir, "plugin.js"), "utf8")).toBe(PLUGIN_FILES[0].content)
    expect(fs.readFileSync(path.join(dir, "lib", "util.js"), "utf8")).toBe(PLUGIN_FILES[1].content)
    const pluginArr = readCfg().plugin
    expect(pluginArr).toEqual([path.join(dir, "plugin.js")])
    const rec = findRecordV2(globalRoot, "plugin", "demo-plugin")
    expect(rec).not.toBeNull()
    expect(rec!.configKey).toBe(`plugin-path:${path.join(dir, "plugin.js")}`)
    expect(rec!.files).toEqual([dir])
    expect(fs.existsSync(capabilityGrantPath(globalRoot, "plugin--demo-plugin"))).toBe(true)
  })

  test("首装停在 authorize:零权威副作用,staging 不留目录(内容寻址,重驱重 staging)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const first = await installCatalog(pluginSeedIntent, pluginDeps())
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBe("authorize")
    // 非提交路径已清理(plugins/ 空壳父目录可留,零条目)。
    const leftover = fs.existsSync(path.join(globalRoot, "plugins")) ? fs.readdirSync(path.join(globalRoot, "plugins")) : []
    expect(leftover).toEqual([])
    expect(fs.existsSync(path.join(globalRoot, "alpha.jsonc"))).toBe(false)
    expect(findRecordV2(globalRoot, "plugin", "demo-plugin")).toBeNull()
  })

  test("same-version healthy 幂等早退:重装零副作用,目录不累积", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    expect((await installAuthorized(pluginSeedIntent, pluginDeps())).ok).toBe(true)
    const again = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.warning).toContain("nothing to replace")
    const dirs = fs.readdirSync(path.join(globalRoot, "plugins")).filter((n) => !n.startsWith("."))
    expect(dirs).toEqual([`demo-plugin@${pluginDigest16(PLUGIN_FILES)}`])
  })

  test("旧版在装 → journaled replace(staging 源 = CAS):config 换元、旧目录 GC、账本更新", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    expect((await installAuthorized(pluginSeedIntent, pluginDeps())).ok).toBe(true)
    const oldDir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)

    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES_V2, version: "1.1.0" }])
    const v2Entry = bundledPluginEntry({ version: "1.1.0", remoteAsset: { version: "1.1.0", files: lockFileEntries(PLUGIN_FILES_V2, { writeBlobs: false }) } })
    const r = await installAuthorized(pluginSeedIntent, makeSeedDeps({ bundledEntries: [v2Entry] }))
    expect(r.ok).toBe(true)
    const newDir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES_V2)}`)
    expect(fs.readFileSync(path.join(newDir, "plugin.js"), "utf8")).toBe(PLUGIN_FILES_V2[0].content)
    expect(readCfg().plugin).toEqual([path.join(newDir, "plugin.js")]) // 精确换元
    expect(fs.existsSync(oldDir)).toBe(false) // 旧目录提交成功后 GC
    const rec = findRecordV2(globalRoot, "plugin", "demo-plugin")
    expect(rec!.version).toBe("1.1.0")
  })

  test("同 payload 仅版本变化的 replace:新旧目录相同,GC 不得删掉刚提交的运行目录(review #383)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    expect((await installAuthorized(pluginSeedIntent, pluginDeps())).ok).toBe(true)
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    const jsPath = path.join(dir, "plugin.js")

    // 同字节、版本 1.0.0 → 1.1.0:dispatch=replace(manifest/version 变化,vendoredHealthy 不成立)。
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES, version: "1.1.0" }])
    const bumped = bundledPluginEntry({ version: "1.1.0", remoteAsset: { version: "1.1.0", files: lockFileEntries(PLUGIN_FILES, { writeBlobs: false }) } })
    const r = await installAuthorized(pluginSeedIntent, makeSeedDeps({ bundledEntries: [bumped] }))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(jsPath, "utf8")).toBe(PLUGIN_FILES[0].content) // 运行目录仍在且完好
    expect(readCfg().plugin).toEqual([jsPath])
    const rec = findRecordV2(globalRoot, "plugin", "demo-plugin")
    expect(rec!.version).toBe("1.1.0")
  })

  test("replace 异 payload:新内容寻址目录在场 = 无账在场,锁内拒不认领(review r2 Blocker)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    expect((await installAuthorized(pluginSeedIntent, pluginDeps())).ok).toBe(true)
    // 目标 v2 目录被外部占用(含垃圾)。
    const d2 = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES_V2)}`)
    fs.mkdirSync(d2, { recursive: true })
    fs.writeFileSync(path.join(d2, "junk.js"), "junk")
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES_V2, version: "1.1.0" }])
    const v2Entry = bundledPluginEntry({ version: "1.1.0", remoteAsset: { version: "1.1.0", files: lockFileEntries(PLUGIN_FILES_V2, { writeBlobs: false }) } })
    const r = await installAuthorized(pluginSeedIntent, makeSeedDeps({ bundledEntries: [v2Entry] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("without a ledger record")
    expect(fs.readFileSync(path.join(d2, "junk.js"), "utf8")).toBe("junk") // 现场不动
  })

  test("同版本重装遇实物被篡改 → 走修复路径(完整 journaled replace 重写清单文件,review r2 Major)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const deps = pluginDeps()
    expect((await installAuthorized(pluginSeedIntent, deps)).ok).toBe(true)
    const jsPath = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`, "plugin.js")
    fs.writeFileSync(jsPath, "tampered live payload")
    const repair = await installAuthorized(pluginSeedIntent, deps)
    expect(repair.ok).toBe(true)
    if (repair.ok) expect(repair.warning ?? "").not.toContain("nothing to replace") // 不是幂等早退
    expect(fs.readFileSync(jsPath, "utf8")).toBe(PLUGIN_FILES[0].content) // 修复回清单字节
  })

  test("载荷路径大小写折叠碰撞 fail-closed(review r2 Major)", async () => {
    const collide = [
      { path: "plugin.js", content: "export const Demo = 1" },
      { path: "Lib.js", content: "A" },
      { path: "lib.js", content: "b" },
    ]
    buildSeed([{ id: "plugin:demo-plugin", files: collide }])
    const r = await installAuthorized(
      pluginSeedIntent,
      pluginDeps({ remoteAsset: { version: "1.0.0", files: lockFileEntries(collide, { writeBlobs: false }) } }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("colliding")
  })

  test("recovery 回滚遗留的纯空目录树不阻断重试(review r3 Major 4:壳容忍)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true }) // 模拟 recovery unlink 后的空壳
    const r = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, "plugin.js"), "utf8")).toBe(PLUGIN_FILES[0].content)
  })

  test("同目录 repair 遇清单外文件:锁内分类 blocked 拒,不假装收敛(review r4 Major)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const deps = pluginDeps()
    expect((await installAuthorized(pluginSeedIntent, deps)).ok).toBe(true)
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    // 同时篡改清单文件(触发不健康 → 走 replace)并植入清单外文件(修复不可收敛)。
    fs.writeFileSync(path.join(dir, "plugin.js"), "tampered")
    fs.writeFileSync(path.join(dir, "extra.js"), "unmanifested")
    const r = await installAuthorized(pluginSeedIntent, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unmanifested content")
    expect(fs.readFileSync(path.join(dir, "extra.js"), "utf8")).toBe("unmanifested") // 现场不动
    expect(fs.readFileSync(path.join(dir, "plugin.js"), "utf8")).toBe("tampered") // 篡改文件也不动(r5)
  })

  test("清单文件被换成同名目录:repair 不可收敛 → blocked 拒(review r5 Major)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const deps = pluginDeps()
    expect((await installAuthorized(pluginSeedIntent, deps)).ok).toBe(true)
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    fs.rmSync(path.join(dir, "plugin.js"), { force: true })
    fs.mkdirSync(path.join(dir, "plugin.js")) // 同名空目录:prepareFileTx 无法覆盖成文件
    const r = await installAuthorized(pluginSeedIntent, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("unmanifested content")
    expect(fs.statSync(path.join(dir, "plugin.js")).isDirectory()).toBe(true) // 现场不动
  })

  test("同版本重装遇目录被换 symlink:不得误判 healthy,也不得经 symlink 写入(review r3 Major 5)", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const deps = pluginDeps()
    expect((await installAuthorized(pluginSeedIntent, deps)).ok).toBe(true)
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    // 把目录换成指向内容完全一致副本的 symlink。
    const copy = path.join(tmp, "plugin-copy")
    fs.cpSync(dir, copy, { recursive: true })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.symlinkSync(copy, dir)
    const again = await installAuthorized(pluginSeedIntent, deps)
    expect(again.ok).toBe(false) // 既非幂等早退成功,也不落 symlink 写入
    expect(fs.readFileSync(path.join(copy, "plugin.js"), "utf8")).toBe(PLUGIN_FILES[0].content) // 树外零写
  })

  test("旧目录 GC 持锁重读引用(review r2 Blocker):被引用/锁忙保留,无引用才删", async () => {
    const { gcVendoredPluginDirLocked } = await import("./ext-install-planner")
    const oldDir = path.join(globalRoot, "plugins", "demo-plugin@aaaabbbbccccdddd")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, "plugin.js"), "x")
    const oldJs = path.join(oldDir, "plugin.js")
    // 被 config 重新引用 → 保留。
    const referenced = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [oldJs] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(referenced.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    // #378 r5 Blocker:等价形态引用同样保留 —— 相对路径(引擎按 config 目录解析)与元组 spec 头。
    const relRef = gcVendoredPluginDirLocked(
      globalRoot,
      "demo-plugin",
      oldDir,
      () => ({ ok: true, value: ["./plugins/demo-plugin@aaaabbbbccccdddd/plugin.js"] }),
      () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }),
    )
    expect(relRef.removed).toBe(false)
    const tupleRef = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [[oldJs, { opt: true }]] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(tupleRef.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    // #378 r13:引用经 symlink 别名指向旧目录 → realpath 身份对账保留。
    const aliasBase = path.join(globalRoot, "alias-plug")
    fs.symlinkSync(oldDir, aliasBase)
    const symRef = gcVendoredPluginDirLocked(
      globalRoot,
      "demo-plugin",
      oldDir,
      () => ({ ok: true, value: [path.join(aliasBase, "plugin.js")] }),
      () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }),
    )
    expect(symRef.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    fs.rmSync(aliasBase, { force: true })
    // #378 r6 Blocker:legacy XDG 源仍引用旧目录 → 保留;legacy 不可读 → fail-closed 保留。
    const legacyRef = gcVendoredPluginDirLocked(
      globalRoot,
      "demo-plugin",
      oldDir,
      () => ({ ok: true, value: [] }),
      () => ({ ok: true as const, sources: [{ value: [oldJs] as unknown[], configDir: "/legacy" }] }),
    )
    expect(legacyRef.removed).toBe(false)
    const legacyBad = gcVendoredPluginDirLocked(
      globalRoot,
      "demo-plugin",
      oldDir,
      () => ({ ok: true, value: [] }),
      () => ({ ok: false as const, reason: "legacy unreadable" }),
    )
    expect(legacyBad.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    // 锁忙 → 保留。
    const held = tryAcquireBundleLock(globalRoot, { txId: "probe" })
    expect(held.ok).toBe(true)
    if (held.ok) {
      const busy = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
      expect(busy.removed).toBe(false)
      held.lock.release()
    }
    // 圈禁外 → 保留。
    const outside = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", path.join(globalRoot, "evil"), () => ({ ok: true, value: [] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(outside.removed).toBe(false)
    // 账本损坏 → fail-closed 保留(review r3:读不出记录 ≠ 无引用)。
    fs.writeFileSync(path.join(globalRoot, "installs.json"), "{ not json")
    const corrupt = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(corrupt.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    fs.rmSync(path.join(globalRoot, "installs.json"), { force: true })
    // 合法 JSON 但含不可解码记录(warnings)→ 同样 fail-closed 保留(review r4)。
    const broken: UpsertInput = {
      id: "plugin:other",
      name: "other",
      kind: "plugin",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(upsertRecordV2(globalRoot, broken).ok).toBe(true)
    const ledgerPath2 = path.join(globalRoot, "installs.json")
    const parsedLedger: unknown = JSON.parse(fs.readFileSync(ledgerPath2, "utf8"))
    if (!isRec(parsedLedger)) throw new Error("ledger not an object")
    for (const v of Object.values(parsedLedger)) {
      if (!Array.isArray(v)) continue
      for (const rec of v) if (isRec(rec) && rec.kind === "plugin") rec.schemaVersion = 99
    }
    fs.writeFileSync(ledgerPath2, JSON.stringify(parsedLedger))
    const undecodable = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(undecodable.removed).toBe(false)
    expect(fs.existsSync(oldDir)).toBe(true)
    fs.rmSync(ledgerPath2, { force: true })
    // 无引用 + 拿到锁 → 删。
    const removed = gcVendoredPluginDirLocked(globalRoot, "demo-plugin", oldDir, () => ({ ok: true, value: [] }), () => ({ ok: true as const, sources: [] as Array<{ value: unknown[]; configDir: string }> }))
    expect(removed.removed).toBe(true)
    expect(fs.existsSync(oldDir)).toBe(false)
  })

  test("downgrade 拒:已装更高版本时 seed 不提供降级通道", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES_V2, version: "2.0.0" }])
    const v2Entry = bundledPluginEntry({ version: "2.0.0", remoteAsset: { version: "2.0.0", files: lockFileEntries(PLUGIN_FILES_V2, { writeBlobs: false }) } })
    expect((await installAuthorized(pluginSeedIntent, makeSeedDeps({ bundledEntries: [v2Entry] }))).ok).toBe(true)

    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const down = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.reason).toContain("refusing downgrade")
  })

  test("npm plugin / 缺 plugin.js / 篡改的同 digest 目录 / 无账 bare 目录:一律 fail-closed 拒", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const npm = await installAuthorized(pluginSeedIntent, pluginDeps({ installSpec: { kind: "plugin", package: "demo-pkg" } }))
    expect(npm.ok).toBe(false)
    if (!npm.ok) expect(npm.reason).toContain("npm plugin has no offline CAS payload")

    const noJs = [{ path: "index.js", content: "x" }]
    buildSeed([{ id: "plugin:demo-plugin", files: noJs }])
    const missing = await installAuthorized(pluginSeedIntent, pluginDeps({ remoteAsset: { version: "1.0.0", files: lockFileEntries(noJs, { writeBlobs: false }) } }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain("plugin.js")

    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    // fresh 时内容寻址目录已在场 = 无账在场(外部放置/历史残留)—— 未策展不认领,journaled
    // 覆盖也不做(review #383 结构性修正后语义)。
    const stagedDir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    fs.mkdirSync(stagedDir, { recursive: true })
    fs.writeFileSync(path.join(stagedDir, "plugin.js"), "tampered")
    const tampered = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.reason).toContain("without a ledger record")
    fs.rmSync(stagedDir, { recursive: true, force: true })

    fs.mkdirSync(path.join(globalRoot, "plugins", "demo-plugin"), { recursive: true })
    const bare = await installAuthorized(pluginSeedIntent, pluginDeps())
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.reason).toContain("without a ledger record")
  })

  test("卸载联动清授权账(vendored 落点),重装重新弹 authorize", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const deps = pluginDeps()
    expect((await installAuthorized(pluginSeedIntent, deps)).ok).toBe(true)
    const jsPath = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`, "plugin.js")

    const installers: PlannerInstallers = {
      ...forbiddenInstallers(),
      removePluginPath: (_name, _absJsPath) => {
        fs.writeFileSync(path.join(globalRoot, "alpha.jsonc"), "{}\n")
        return { ok: true }
      },
    }
    const un = await uninstallByKey({ type: "plugin", name: "demo-plugin", scope: "global" }, { ...deps, installers })
    expect(un.ok).toBe(true)
    expect(findRecordV2(globalRoot, "plugin", "demo-plugin")).toBeNull()
    expect(fs.existsSync(capabilityGrantPath(globalRoot, "plugin--demo-plugin"))).toBe(false)
    expect(fs.existsSync(path.dirname(jsPath))).toBe(false) // 卸载删除 vendored 目录
    const again = await installCatalog(pluginSeedIntent, deps)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.stage).toBe("authorize")
  })
})

// ── #348:seed 路径的 authorize 闸显式锁定(capabilities 漏传即此测试失败)────────────────────────
describe("seed capability authorize gate (REQ-100 #348)", () => {
  test("seed 首装零权威副作用停在 authorize,requested = manifest.capabilities", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    const first = await installCatalog(seedIntent, deps)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBe("authorize")
    if (first.stage !== "authorize") throw new Error("unreachable")
    expect(first.authorization).toHaveLength(1)
    expect(first.authorization[0]!.key).toBe(skillGenerationKey("hello"))
    expect(first.authorization[0]!.requested).toEqual(["prompt:context"])
    expect(first.authorization[0]!.previous).toBeNull()
    expect(resolveLiveGenerationDir(globalRoot, skillGenerationKey("hello"))).toBeNull()
    expect(findRecordV2(globalRoot, "skill", "hello")).toBeNull()
  })
})

// ── #395(REQ-104):第三方(official/community)fresh 安装默认关 —— 落盘形态全查 ─────────────────

describe("#395 第三方 seed 安装默认关(disabled 投影落盘)", () => {
  test("official plugin fresh:账本 disabled;plugin[] 无条目(在场性投影);载荷/授权账照常落位", async () => {
    buildSeed([{ id: "plugin:demo-plugin", files: PLUGIN_FILES }])
    const entry = bundledPluginEntry({ source: "official" })
    const r = await installAuthorized(pluginSeedIntent, makeSeedDeps({ bundledEntries: [entry] }))
    expect(r.ok).toBe(true)
    const rec = findRecordV2(globalRoot, "plugin", "demo-plugin")!
    expect(rec.desiredState).toBe("disabled")
    const cfg: { plugin?: string[] } = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    expect(cfg.plugin ?? []).toEqual([])
    // 内容照常物化(disabled ≠ 未安装):enable 只翻投影,不再下载。
    const dir = path.join(globalRoot, "plugins", `demo-plugin@${pluginDigest16(PLUGIN_FILES)}`)
    expect(fs.existsSync(path.join(dir, "plugin.js"))).toBe(true)
    // 启用:set-state 事务按 configKey 物化条目 + 账本翻开。
    const en = await setInstallStateByKey(
      { type: "plugin", name: "demo-plugin", scope: "global", state: "enabled" },
      { globalRoot: () => globalRoot, advisoryGate: () => ({ allowed: true }) },
    )
    expect(en.ok).toBe(true)
    const cfg2: { plugin: string[] } = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    expect(cfg2.plugin).toEqual([path.join(dir, "plugin.js")])
    expect(findRecordV2(globalRoot, "plugin", "demo-plugin")!.desiredState).toBe("enabled")
  })

  test("official mcp fresh:账本 disabled;config 叶带引擎原生 disabled:true;不发 liveMcp(装 ≠ 连)", async () => {
    buildSeed([{ id: "mcp:demo", files: MCP_FILES }])
    const entry = bundledMcpEntry({ source: "official" })
    const r = await installAuthorized(mcpSeedIntent, makeSeedDeps({ bundledEntries: [entry] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect("liveMcp" in r ? r.liveMcp : undefined).toBeUndefined()
    expect(findRecordV2(globalRoot, "mcp", "demo")!.desiredState).toBe("disabled")
    const cfg: { mcp: Record<string, Record<string, unknown>> } = JSON.parse(fs.readFileSync(path.join(globalRoot, "alpha.jsonc"), "utf8"))
    expect(cfg.mcp.demo?.disabled).toBe(true)
  })
})
