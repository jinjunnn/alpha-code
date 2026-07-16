// REQ-102 A —— packaged seed 消费端单测:lock 严格解码(未知键/降级混淆拒绝)、拒绝矩阵
// S5-S11 同语义负向、纯读语义(浏览零写入)、blob 提升两遍式(展开前拒绝)与 CAS 幂等。
// 全部真盘临时目录、fixtures 自建(B 侧 fixtures 思路)、零 mock(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { casPaths, hasCasBlob } from "./ext-cas"
import {
  decodeSeedLock,
  packagedSeedBrowseView,
  promoteSeedAssetToCas,
  readPackagedSeed,
  seedAssetTxFiles,
  seedBlobPath,
  verifySeedAsset,
  type SeedLock,
} from "./ext-seed"

let tmp: string
let seedDir: string
let casBase: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-seed-"))
  seedDir = path.join(tmp, "extension-seed")
  casBase = path.join(tmp, "alpha-base")
  fs.mkdirSync(seedDir, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex")

type FileFixture = { path: string; content: string }
type AssetFixture = {
  id: string
  files: FileFixture[]
  license?: string
  source?: string
  platforms?: string[]
  licenseFiles?: string[]
}

/** 构造合法 lock(+可选写 blob 进 seedDir),负向用例在其上做单点变异。 */
function buildLock(assets: AssetFixture[], opts: { writeBlobs?: boolean; budget?: Partial<SeedLock["budget"]> } = {}): SeedLock {
  const budget = { maxAssetBytes: 16777216, maxTotalBytes: 67108864, maxFilesPerAsset: 512, ...opts.budget }
  let total = 0
  const lockAssets = assets.map((a) => {
    const files = [...a.files]
      .sort((x, y) => (x.path < y.path ? -1 : 1))
      .map((f) => {
        const digest = sha(f.content)
        if (opts.writeBlobs !== false) {
          const blob = seedBlobPath(seedDir, digest)!
          fs.mkdirSync(path.dirname(blob), { recursive: true })
          fs.writeFileSync(blob, f.content)
        }
        return { path: f.path, sha256: digest, bytes: Buffer.byteLength(f.content), url: `https://alphacodeone.com/catalog/assets/x/${f.path}` }
      })
    const bytes = files.reduce((s, f) => s + f.bytes, 0)
    total += bytes
    return {
      id: a.id,
      type: a.id.split(":")[0]!,
      version: "1.0.0",
      license: a.license ?? "MIT",
      source: a.source ?? "alpha",
      redistributable: true as const,
      platforms: a.platforms ?? ["*"],
      licenseFiles: a.licenseFiles ?? (a.source && a.source !== "alpha" ? ["LICENSE.txt"] : []),
      bytes,
      files,
    }
  })
  return {
    schema: "alpha.extension-seed.lock.v1",
    channel: "stable",
    catalogVersion: "2026-07-13.1",
    catalog: {
      sha256: sha("catalog payload"),
      bytes: 59424,
      url: "https://alphacodeone.com/catalog/v1/releases/2026-07-13.1/catalog.json",
      sigUrl: "https://alphacodeone.com/catalog/v1/releases/2026-07-13.1/catalog.json.sig",
    },
    supportedPlatforms: ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
    budget,
    totalBytes: total,
    assets: lockAssets.sort((x, y) => (x.id < y.id ? -1 : 1)),
  }
}

const writeLock = (lock: unknown) => fs.writeFileSync(path.join(seedDir, "seed.lock.json"), JSON.stringify(lock, null, 2))
const PLATFORM = "darwin-arm64"

const baseAssets: AssetFixture[] = [
  { id: "skill:demo", files: [{ path: "SKILL.md", content: "# demo" }, { path: "ref/notes.md", content: "notes" }] },
  {
    id: "skill:third-party",
    source: "official",
    license: "Apache-2.0",
    licenseFiles: ["LICENSE.txt"],
    files: [{ path: "LICENSE.txt", content: "Apache License" }, { path: "SKILL.md", content: "# third" }],
  },
]

describe("decodeSeedLock — strict schema", () => {
  test("accepts a well-formed lock", () => {
    const r = decodeSeedLock(JSON.stringify(buildLock(baseAssets, { writeBlobs: false })))
    expect(r.ok).toBeTrue()
  })

  const mutate = (fn: (l: Record<string, unknown>) => void): ReturnType<typeof decodeSeedLock> => {
    const lock = JSON.parse(JSON.stringify(buildLock(baseAssets, { writeBlobs: false }))) as Record<string, unknown>
    fn(lock)
    return decodeSeedLock(JSON.stringify(lock))
  }
  const firstAsset = (l: Record<string, unknown>) => (l.assets as Record<string, unknown>[])[0]!

  test("unknown top-level key rejects (anti-downgrade, contract §7)", () => {
    const r = mutate((l) => (l.extra = 1))
    expect(!r.ok && r.error.includes("unknown keys")).toBeTrue()
  })
  test("unknown schema / non-stable channel reject", () => {
    expect(mutate((l) => (l.schema = "alpha.extension-seed.lock.v2")).ok).toBeFalse()
    expect(mutate((l) => (l.channel = "preview")).ok).toBeFalse()
  })
  test("unknown asset key rejects", () => {
    expect(mutate((l) => (firstAsset(l).sneaky = true)).ok).toBeFalse()
  })
  test("S5: traversal / absolute / dot-segment paths reject", () => {
    for (const p of ["../escape.md", "/abs.md", "a/./b.md", "a\\b.md"]) {
      const r = mutate((l) => {
        const f = (firstAsset(l).files as Record<string, unknown>[])[0]!
        f.path = p
      })
      expect(r.ok).toBeFalse()
    }
  })
  test("S7: license outside allowlist / redistributable!=true reject", () => {
    expect(mutate((l) => (firstAsset(l).license = "GPL-3.0")).ok).toBeFalse()
    expect(mutate((l) => (firstAsset(l).redistributable = false)).ok).toBeFalse()
  })
  test("S8: third-party asset without license text rejects", () => {
    const r = mutate((l) => {
      const a = (l.assets as Record<string, unknown>[])[1]!
      a.licenseFiles = []
    })
    expect(!r.ok && r.error.includes("S8")).toBeTrue()
  })
  test("S9: bad platform token / '*' mixed / disjoint / unsorted reject", () => {
    expect(mutate((l) => (firstAsset(l).platforms = ["darwin-arm64", "*"])).ok).toBeFalse()
    expect(mutate((l) => (firstAsset(l).platforms = ["amiga-68k"])).ok).toBeFalse()
    expect(mutate((l) => (firstAsset(l).platforms = ["linux-x64"])).ok).toBeFalse() // 与 supportedPlatforms 无交集
    expect(mutate((l) => (firstAsset(l).platforms = ["win32-x64", "darwin-arm64"])).ok).toBeFalse()
    expect(mutate((l) => (l.supportedPlatforms = ["darwin-arm64", "darwin-arm64"])).ok).toBeFalse()
  })
  test("S10: budgets are re-executed from recorded values", () => {
    expect(!decodeSeedLock(JSON.stringify(buildLock(baseAssets, { writeBlobs: false, budget: { maxFilesPerAsset: 1 } }))).ok).toBeTrue()
    expect(!decodeSeedLock(JSON.stringify(buildLock(baseAssets, { writeBlobs: false, budget: { maxAssetBytes: 3 } }))).ok).toBeTrue()
    expect(!decodeSeedLock(JSON.stringify(buildLock(baseAssets, { writeBlobs: false, budget: { maxTotalBytes: 5 } }))).ok).toBeTrue()
  })
  test("totals consistency: asset bytes and totalBytes must equal file sums", () => {
    expect(mutate((l) => (firstAsset(l).bytes = 999999)).ok).toBeFalse()
    expect(mutate((l) => (l.totalBytes = 0)).ok).toBeFalse()
  })
  test("determinism: unsorted assets / files / duplicate ids reject", () => {
    expect(mutate((l) => (l.assets as unknown[]).reverse()).ok).toBeFalse()
    expect(mutate((l) => (firstAsset(l).files as unknown[]).reverse()).ok).toBeFalse()
    const dup = mutate((l) => {
      const assets = l.assets as Record<string, unknown>[]
      assets.push(JSON.parse(JSON.stringify(assets[1]!)))
    })
    expect(dup.ok).toBeFalse()
  })
})

describe("readPackagedSeed — browse face (pure read)", () => {
  test("reads lock, marks availability bundled and per-asset platform compatibility", () => {
    const lock = buildLock([
      ...baseAssets,
      { id: "skill:mac-only", platforms: ["darwin-arm64", "darwin-x64"], files: [{ path: "SKILL.md", content: "mac" }] },
      { id: "skill:win-only", platforms: ["win32-arm64", "win32-x64"], files: [{ path: "SKILL.md", content: "win" }] },
    ])
    writeLock(lock)
    fs.writeFileSync(path.join(seedDir, "NOTICE.md"), "# NOTICE")
    const before = fs.readdirSync(seedDir).sort()
    const r = readPackagedSeed(seedDir, { platformToken: PLATFORM })
    expect(r.ok).toBeTrue()
    if (!r.ok) return
    expect(r.seed.assets.every((a) => a.availability === "bundled")).toBeTrue()
    expect(r.seed.assets.find((a) => a.id === "skill:mac-only")?.platformCompatible).toBeTrue()
    expect(r.seed.assets.find((a) => a.id === "skill:win-only")?.platformCompatible).toBeFalse()
    expect(r.seed.noticePath).toBe(path.join(seedDir, "NOTICE.md"))
    // 纯读:目录内容零变化(无配置写入/无缓存文件)。
    expect(fs.readdirSync(seedDir).sort()).toEqual(before)
    expect(fs.existsSync(casPaths(casBase).root)).toBeFalse()
  })

  test("missing seed / symlinked lock / unsupported app platform all reject", () => {
    expect(readPackagedSeed(seedDir, { platformToken: PLATFORM }).ok).toBeFalse()
    const real = path.join(tmp, "real-lock.json")
    fs.writeFileSync(real, JSON.stringify(buildLock(baseAssets, { writeBlobs: false })))
    fs.symlinkSync(real, path.join(seedDir, "seed.lock.json"))
    const viaLink = readPackagedSeed(seedDir, { platformToken: PLATFORM })
    expect(!viaLink.ok && viaLink.error.includes("not a regular file")).toBeTrue()
    fs.rmSync(path.join(seedDir, "seed.lock.json"))
    writeLock(buildLock(baseAssets, { writeBlobs: false }))
    const linux = readPackagedSeed(seedDir, { platformToken: "linux-x64" })
    expect(!linux.ok && linux.error.includes("S9")).toBeTrue()
  })
})

describe("verifySeedAsset / promoteSeedAssetToCas — import face", () => {
  test("verified asset promotes into CAS; repeat is idempotent; nothing else is written", () => {
    const lock = buildLock(baseAssets)
    writeLock(lock)
    const r = promoteSeedAssetToCas(seedDir, lock, "skill:demo", casBase, { platformToken: PLATFORM })
    expect(r.ok).toBeTrue()
    if (!r.ok) return
    expect(r.promoted).toBe(2)
    expect(r.alreadyPresent).toBe(0)
    for (const f of r.files) expect(hasCasBlob(casBase, f.sha256)).toBeTrue()
    // 只提升 CAS blob:不装、不启用 —— casBase 下只有 cas/ 一棵树。
    expect(fs.readdirSync(casBase)).toEqual(["cas"])
    const again = promoteSeedAssetToCas(seedDir, lock, "skill:demo", casBase, { platformToken: PLATFORM })
    expect(again.ok && again.alreadyPresent === 2 && again.promoted === 0).toBeTrue()
    // 未选装资产的 blob 不被复制(不复制整个 seed)。
    const other = lock.assets.find((a) => a.id === "skill:third-party")!
    expect(other.files.some((f) => hasCasBlob(casBase, f.sha256))).toBeFalse()
  })

  test("S11: digest mismatch rejects BEFORE any CAS write (whole asset)", () => {
    const lock = buildLock(baseAssets)
    writeLock(lock)
    const victim = lock.assets.find((a) => a.id === "skill:demo")!
    // 让第二个文件的 blob 内容漂移(第一个文件保持合法)——两遍式必须在写入前拒绝整单。
    const drift = victim.files[1]!
    fs.writeFileSync(seedBlobPath(seedDir, drift.sha256)!, "tampered content")
    const r = promoteSeedAssetToCas(seedDir, lock, "skill:demo", casBase, { platformToken: PLATFORM })
    expect(r.ok).toBeFalse()
    if (r.ok) return
    expect(r.reason).toContain("MISMATCH")
    expect(fs.existsSync(casPaths(casBase).root)).toBeFalse() // 零写入
  })

  test("S6: symlinked blob / symlinked parent dir / escape all reject", () => {
    const lock = buildLock(baseAssets)
    writeLock(lock)
    const asset = lock.assets.find((a) => a.id === "skill:demo")!
    const f0 = asset.files[0]!
    const blob = seedBlobPath(seedDir, f0.sha256)!
    const outside = path.join(tmp, "outside-blob")
    fs.copyFileSync(blob, outside)
    fs.rmSync(blob)
    fs.symlinkSync(outside, blob)
    const viaLink = verifySeedAsset(seedDir, lock, "skill:demo", { platformToken: PLATFORM })
    expect(!viaLink.ok && viaLink.reason.includes("S6")).toBeTrue()

    // 父目录 symlink:整个分片目录指向 seed 外。
    fs.rmSync(blob)
    const shardDir = path.dirname(blob)
    const outsideDir = path.join(tmp, "outside-shard")
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.copyFileSync(outside, path.join(outsideDir, path.basename(blob)))
    fs.rmSync(shardDir, { recursive: true, force: true })
    fs.symlinkSync(outsideDir, shardDir)
    const viaDir = verifySeedAsset(seedDir, lock, "skill:demo", { platformToken: PLATFORM })
    expect(!viaDir.ok && viaDir.reason.includes("S6")).toBeTrue()
  })

  test("S6: missing blob rejects; S9: platform-incompatible asset refuses promotion", () => {
    const lock = buildLock([
      ...baseAssets,
      { id: "skill:win-only", platforms: ["win32-arm64", "win32-x64"], files: [{ path: "SKILL.md", content: "win" }] },
    ])
    writeLock(lock)
    const demo = lock.assets.find((a) => a.id === "skill:demo")!
    fs.rmSync(seedBlobPath(seedDir, demo.files[0]!.sha256)!)
    const missing = verifySeedAsset(seedDir, lock, "skill:demo", { platformToken: PLATFORM })
    expect(!missing.ok && missing.reason.includes("S6")).toBeTrue()
    const wrongPlat = promoteSeedAssetToCas(seedDir, lock, "skill:win-only", casBase, { platformToken: PLATFORM })
    expect(!wrongPlat.ok && wrongPlat.reason.includes("S9")).toBeTrue()
    expect(verifySeedAsset(seedDir, lock, "skill:not-there", { platformToken: PLATFORM }).ok).toBeFalse()
  })

  test("S11: declared-size mismatch rejects", () => {
    const lock = buildLock(baseAssets)
    const demo = lock.assets.find((a) => a.id === "skill:demo")!
    demo.files[0]!.bytes += 1
    demo.bytes += 1
    lock.totalBytes += 1
    writeLock(lock)
    const r = verifySeedAsset(seedDir, lock, "skill:demo", { platformToken: PLATFORM })
    expect(!r.ok && r.reason.includes("S11")).toBeTrue()
  })

  test("seedAssetTxFiles exposes the TxPlan file manifest seam", () => {
    const lock = buildLock(baseAssets, { writeBlobs: false })
    const files = seedAssetTxFiles(lock, "skill:demo")
    expect(files).toHaveLength(2)
    expect(files![0]).toEqual({ path: "SKILL.md", sha256: sha("# demo"), size: 6 })
    expect(seedAssetTxFiles(lock, "skill:none")).toBeNull()
  })
})

// ── REQ-102 #316:浏览面 IPC 投影(纯读、零路径外泄)──────────────────────────────────────────

describe("packagedSeedBrowseView(#316)", () => {
  test("合法 seed → 安全投影:元数据齐全,零绝对路径/blob 布局/url 外泄", () => {
    writeLock(buildLock(baseAssets))
    // 与本文件其余测试一致注入 platformToken —— fixture 只声明 darwin/win32(S9 负测依赖此形状),
    // 不注入会在 linux CI 被 S9 门整体拒(#317 起本测试在 linux CI 恒红,#358 顺手修复)。
    const v = packagedSeedBrowseView(seedDir, { platformToken: PLATFORM })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.catalogVersion).toBe("2026-07-13.1")
    expect(v.assets.length).toBeGreaterThan(0)
    for (const a of v.assets) {
      expect(a.availability).toBe("bundled")
      expect(typeof a.fileCount).toBe("number")
      expect(a.fileCount).toBeGreaterThan(0)
    }
    const wire = JSON.stringify(v)
    expect(wire.includes(seedDir)).toBe(false) // 零绝对路径
    expect(wire.includes("blobs")).toBe(false) // 零 blob 布局
    expect(wire.includes("https://")).toBe(false) // 零 url
  })

  test("无 packaged seed(null)与 lock 损坏 → 结构化拒绝(fail closed)", () => {
    const none = packagedSeedBrowseView(null)
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toContain("no packaged seed")
    fs.writeFileSync(path.join(seedDir, "seed.lock.json"), "{ corrupt")
    const corrupt = packagedSeedBrowseView(seedDir)
    expect(corrupt.ok).toBe(false)
  })
})
