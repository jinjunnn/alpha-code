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

const entryBase = { displayName: "d", description: "d", source: "official" as const, category: "test" }

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

/** seed 路径的完成定义之一:planner installers 一个都不许被触碰。 */
function forbiddenInstallers(): PlannerInstallers {
  const forbid = (fn: string) => () => {
    throw new Error(`installer ${fn} must not be called on the seed path`)
  }
  return {
    persistMcp: forbid("persistMcp"),
    fileifyMcpSecrets: forbid("fileifyMcpSecrets"),
    removeMcpSecrets: forbid("removeMcpSecrets"),
    removeMcp: forbid("removeMcp"),
    persistPlugin: forbid("persistPlugin"),
    removePlugin: forbid("removePlugin"),
    installVendoredPlugin: forbid("installVendoredPlugin"),
    removePluginPath: forbid("removePluginPath"),
    installBuiltinSkill: forbid("installBuiltinSkill"),
    collectBuiltinSkillPayload: forbid("collectBuiltinSkillPayload"),
    installBuiltinAgent: forbid("installBuiltinAgent"),
    installRemoteSkill: forbid("installRemoteSkill"),
    installRemoteAgent: forbid("installRemoteAgent"),
    removeFsInstall: forbid("removeFsInstall"),
    downloadRemoteAsset: forbid("downloadRemoteAsset"),
  } as unknown as PlannerInstallers
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

  test("refuses mcp/plugin seed assets explicitly (→ #359)", async () => {
    buildSeed([
      { id: "mcp:demo", files: [{ path: "server.json", content: "{}" }] },
      { id: "skill:hello", files: skillFiles },
    ])
    const r = await installAuthorized({ ...seedIntent, assetId: "mcp:demo" }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('type "mcp"')
      expect(r.reason).toContain("#359")
    }
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
