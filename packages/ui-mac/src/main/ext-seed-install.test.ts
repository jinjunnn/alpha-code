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
  type PlannerDeps,
  type PlannerInstallers,
  type VerifiedCatalogEntry,
} from "./ext-install-planner"

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
    supportedPlatforms: ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
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
    const r = await installCatalog(seedIntent, deps)
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
    expect((await installCatalog(seedIntent, deps)).ok).toBe(true)
    const again = await installCatalog(seedIntent, deps)
    expect(again.ok).toBe(true)
  })

  test("self-heals a corrupted in-store CAS blob on reinstall (put replaces, install still verifies)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    expect((await installCatalog(seedIntent, deps)).ok).toBe(true)
    const blob = casBlobPath(casBase, sha(SKILL_MD))!
    fs.writeFileSync(blob, "tampered bytes")
    const again = await installCatalog(seedIntent, deps)
    expect(again.ok).toBe(true)
    expect(fs.readFileSync(blob, "utf8")).toBe(SKILL_MD)
  })

  test("refuses non-global scope (ADR-030 统一收回合同,先于 seed 通道)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installCatalog({ source: "seed", assetId: "skill:hello", scope: { scope: "project", projectDir: tmp } }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("project-scoped catalog/seed installation is unsupported")
  })

  test("refuses unknown keys / grants / non-seed source on the seed intent form", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    const withGrants = await installCatalog({ ...seedIntent, grants: {} }, deps)
    expect(withGrants.ok).toBe(false)
    if (!withGrants.ok) expect(withGrants.reason).toContain('unknown key "grants"')
    const badSource = await installCatalog({ source: "catalog", assetId: "skill:hello", scope: { scope: "global" } }, deps)
    expect(badSource.ok).toBe(false)
    const mixed = await installCatalog({ ...seedIntent, catalogId: "skill:hello" }, deps)
    expect(mixed.ok).toBe(false)
  })

  test("refuses when the seed channel or packaged seed is unavailable", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const noChannel: PlannerDeps = { ...makeSeedDeps(), seed: undefined }
    const r1 = await installCatalog(seedIntent, noChannel)
    expect(r1.ok).toBe(false)
    const r2 = await installCatalog(seedIntent, makeSeedDeps({ seedDirOverride: null }))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("no packaged seed")
  })

  test("refuses a corrupt seed lock (fail closed, loud)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    fs.writeFileSync(path.join(seedDir, "seed.lock.json"), "{ not json")
    const r = await installCatalog(seedIntent, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("packaged seed rejected")
  })

  test("refuses an asset that is not in the packaged seed", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installCatalog({ ...seedIntent, assetId: "skill:missing" }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not in packaged seed")
  })

  test("refuses non-skill seed assets explicitly (agent → #358)", async () => {
    buildSeed([
      { id: "agent:bug-triage", files: [{ path: "AGENT.md", content: "agent body" }] },
      { id: "skill:hello", files: skillFiles },
    ])
    const r = await installCatalog({ ...seedIntent, assetId: "agent:bug-triage" }, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('type "agent"')
      expect(r.reason).toContain("#358")
    }
  })

  test("refuses when the bundled catalog has no matching entry (seed/catalog drift)", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const r = await installCatalog(seedIntent, makeSeedDeps({ bundledEntries: [] }))
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
      const r = await installCatalog(
        seedIntent,
        makeSeedDeps({ bundledEntries: [bundledSkillEntry({ remoteAsset: { version: "1.0.0", files: v.files } })] }),
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("drift")
    }
  })

  test("refuses catalogVersion / version / file-digest drift between seed lock and bundled entry", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const catVer = await installCatalog(seedIntent, makeSeedDeps({ bundledVersion: "2026-07-14.1" }))
    expect(catVer.ok).toBe(false)
    if (!catVer.ok) expect(catVer.reason).toContain("catalogVersion")

    const verDrift = await installCatalog(seedIntent, makeSeedDeps({ bundledEntries: [bundledSkillEntry({ version: "1.0.1" })] }))
    expect(verDrift.ok).toBe(false)
    if (!verDrift.ok) expect(verDrift.reason).toContain("drift")

    const driftedFiles = lockFileEntries(skillFiles, { writeBlobs: false }).map((f) =>
      f.path === "SKILL.md" ? { ...f, sha256: "d".repeat(64) } : f,
    )
    const shaDrift = await installCatalog(
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
    const down = await installCatalog(seedIntent, makeSeedDeps())
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.reason).toContain("refusing downgrade")

    expect(upsertRecordV2(globalRoot, { ...installed, version: "weird-tag" }).ok).toBe(true)
    const weird = await installCatalog(seedIntent, makeSeedDeps())
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
    const r = await installCatalog(seedIntent, makeSeedDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no recorded version")
  })

  test("refuses when the target v2 record is corrupt or the ledger file is unreadable", async () => {
    buildSeed([{ id: "skill:hello", files: skillFiles }])
    const deps = makeSeedDeps()
    expect((await installCatalog(seedIntent, deps)).ok).toBe(true)

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
    const corruptRecord = await installCatalog(seedIntent, deps)
    expect(corruptRecord.ok).toBe(false)
    if (!corruptRecord.ok) expect(corruptRecord.reason).toContain("refusing seed install")

    // 账本文件级损坏:同样 fail-closed。
    fs.writeFileSync(ledger, "{ not json")
    const corruptLedger = await installCatalog(seedIntent, deps)
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
