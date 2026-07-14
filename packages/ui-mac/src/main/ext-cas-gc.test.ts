// REQ-102 A —— CAS mark/sweep GC 单测:四类 mark 根(journal/generation/seed lock/pin)可达即留、
// 不可达且出宽限窗才删、dry-run 零删除全计划、与事务引擎互斥(活锁即整轮跳过)、mark 根不可读
// fail-closed、用户数据/未知条目绝不触碰。全部真盘临时目录、零 mock(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { casBlobPath, casPaths, hasCasBlob, pinCasBlob, putCasBlobFromBuffer } from "./ext-cas"
import { collectCasGarbage, defaultCasGcEnvRoots } from "./ext-cas-gc"

let base: string
let envRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-casgc-"))
  envRoot = path.join(base, "env", "prod")
  fs.mkdirSync(envRoot, { recursive: true })
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex")
const OLD = new Date("2026-01-01T00:00:00Z")

/** 放一个 blob 进 CAS 并把 mtime 拨回宽限窗外(默认视角:早已冷却)。 */
function putOldBlob(content: string): string {
  const digest = sha(content)
  const r = putCasBlobFromBuffer(base, Buffer.from(content), digest)
  if (!r.ok) throw new Error(r.reason)
  fs.utimesSync(r.path, OLD, OLD)
  return digest
}

function writeJournal(root: string, txId: string, fileShas: string[], state = "staging"): void {
  const dir = path.join(root, "ext-tx", "journal")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${txId}.json`),
    JSON.stringify({
      v: 1,
      txId,
      state,
      createdAt: OLD.toISOString(),
      updatedAt: OLD.toISOString(),
      items: [{ key: "skill--x", genId: "gen-000001-aaaaaaaa", files: fileShas.map((s, i) => ({ path: `f${i}.md`, sha256: s })) }],
    }),
  )
}

function writeGeneration(root: string, key: string, genId: string, files: Record<string, string>): void {
  const dir = path.join(root, "ext-store", key, "generations", genId)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
}

/** 最小合法 seed lock(单资产单文件,digest 指向给定内容)。 */
function writeSeedLock(file: string, contents: string[]): void {
  const files = contents
    .map((c, i) => ({ path: `f${i}.md`, sha256: sha(c), bytes: Buffer.byteLength(c), url: `https://alphacodeone.com/x/f${i}.md` }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const bytes = files.reduce((s, f) => s + f.bytes, 0)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: "alpha.extension-seed.lock.v1",
      channel: "stable",
      catalogVersion: "2026-07-13.1",
      catalog: { sha256: sha("payload"), bytes: 1, url: "https://a.example/c.json", sigUrl: "https://a.example/c.json.sig" },
      supportedPlatforms: ["darwin-arm64"],
      budget: { maxAssetBytes: 16777216, maxTotalBytes: 67108864, maxFilesPerAsset: 512 },
      totalBytes: bytes,
      assets: [
        {
          id: "skill:seeded",
          type: "skill",
          version: "1.0.0",
          license: "MIT",
          source: "alpha",
          redistributable: true,
          platforms: ["*"],
          licenseFiles: [],
          bytes,
          files,
        },
      ],
    }),
  )
}

describe("collectCasGarbage — mark roots", () => {
  test("journal / generation / seed-lock / pin referenced blobs survive; unreachable cold blob is swept", () => {
    const byJournal = putOldBlob("journal-referenced")
    const byGeneration = putOldBlob("generation-referenced")
    const bySeed = putOldBlob("seed-referenced")
    const byPin = putOldBlob("pinned")
    const garbage = putOldBlob("unreachable")

    writeJournal(envRoot, "tx-abc-00000001", [byJournal])
    writeGeneration(envRoot, "skill--demo", "gen-000001-aaaaaaaa", { "SKILL.md": "generation-referenced" })
    const seedLock = path.join(base, "resources", "extension-seed", "seed.lock.json")
    writeSeedLock(seedLock, ["seed-referenced"])
    pinCasBlob(base, byPin, "release baseline")

    const r = collectCasGarbage(base, { envRoots: [envRoot], seedLockPaths: [seedLock] })
    expect(r.ok).toBeTrue()
    expect(r.swept).toHaveLength(1)
    expect(r.sweepable.map((s) => s.sha256)).toEqual([garbage])
    for (const kept of [byJournal, byGeneration, bySeed, byPin]) expect(hasCasBlob(base, kept)).toBeTrue()
    expect(hasCasBlob(base, garbage)).toBeFalse()
  })

  test("grace window: unreferenced but fresh blobs are kept and reported", () => {
    const fresh = sha("fresh unreferenced")
    putCasBlobFromBuffer(base, Buffer.from("fresh unreferenced"), fresh)
    const cold = putOldBlob("cold unreferenced")
    const r = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(r.ok).toBeTrue()
    expect(r.keptByGrace).toBe(1)
    expect(hasCasBlob(base, fresh)).toBeTrue()
    expect(hasCasBlob(base, cold)).toBeFalse()
  })

  test("dry-run reports the full sweep plan and deletes nothing", () => {
    const garbage = putOldBlob("dry-run victim")
    const r = collectCasGarbage(base, { envRoots: [envRoot], dryRun: true })
    expect(r.ok && r.dryRun).toBeTrue()
    expect(r.sweepable).toEqual([{ sha256: garbage, bytes: Buffer.byteLength("dry-run victim") }])
    expect(r.swept).toHaveLength(0)
    expect(hasCasBlob(base, garbage)).toBeTrue()
  })
})

describe("collectCasGarbage — fail closed", () => {
  test("live transaction lock on an env root skips the whole GC round", () => {
    const garbage = putOldBlob("must survive contention")
    const acquired = tryAcquireBundleLock(envRoot, { txId: "tx-live-00000001" })
    expect(acquired.ok).toBeTrue()
    if (!acquired.ok) return
    try {
      const r = collectCasGarbage(base, { envRoots: [envRoot] })
      expect(r.ok).toBeFalse()
      expect(r.reason).toContain("mutual exclusion")
      expect(hasCasBlob(base, garbage)).toBeTrue()
    } finally {
      acquired.lock.release()
    }
  })

  test("concurrent GC is serialized by the CAS-level lock", () => {
    putOldBlob("concurrent")
    const { root } = casPaths(base)
    const acquired = tryAcquireBundleLock(root, { txId: "tx-othergc-00000001" })
    expect(acquired.ok).toBeTrue()
    if (!acquired.ok) return
    try {
      const r = collectCasGarbage(base, { envRoots: [envRoot] })
      expect(r.ok).toBeFalse()
      expect(r.reason).toContain("CAS lock busy")
    } finally {
      acquired.lock.release()
    }
  })

  test("unreadable journal / invalid seed lock refuse the whole round (nothing deleted)", () => {
    const garbage = putOldBlob("survives bad mark root")
    const dir = path.join(envRoot, "ext-tx", "journal")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "tx-bad-00000001.json"), "{not json")
    const r1 = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(!r1.ok && r1.reason!.includes("fail closed")).toBeTrue()
    fs.rmSync(path.join(dir, "tx-bad-00000001.json"))

    const badSeed = path.join(base, "seed.lock.json")
    fs.writeFileSync(badSeed, JSON.stringify({ schema: "alpha.extension-seed.lock.v2" }))
    const r2 = collectCasGarbage(base, { envRoots: [envRoot], seedLockPaths: [badSeed] })
    expect(!r2.ok && r2.reason!.includes("fail closed")).toBeTrue()
    expect(hasCasBlob(base, garbage)).toBeTrue()
  })

  test("corrupt pins.json aborts the round — a protected-then-corrupted blob is never swept (REQ-102 #333)", () => {
    // 真实场景:先 pin 保护一个 blob,随后 pin 账损坏(部分写/磁盘错)。GC 绝不能把损坏 pin 账
    // 当空集继续 sweep,否则受保护 blob 被误删(数据丢失)。
    const protectedBlob = putOldBlob("protected by pin then ledger corrupts")
    pinCasBlob(base, protectedBlob, "release baseline")
    const { pinsPath } = casPaths(base)
    // ① JSON 直接损坏
    fs.writeFileSync(pinsPath, "{not: valid json")
    const r1 = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(!r1.ok && r1.reason!.includes("fail closed")).toBeTrue()
    expect(hasCasBlob(base, protectedBlob)).toBeTrue()
    // ② JSON 合法但条目 schema 非法(pinnedAt 缺失)——同样 fail-closed,不逐项静默丢弃
    fs.writeFileSync(pinsPath, JSON.stringify({ v: 1, pins: { [protectedBlob]: { reason: "x" } } }))
    const r2 = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(!r2.ok && r2.reason!.includes("fail closed")).toBeTrue()
    expect(hasCasBlob(base, protectedBlob)).toBeTrue()
  })
})

describe("collectCasGarbage — user data is untouchable", () => {
  test("unknown entries inside the CAS tree are kept with loud warnings; env root is untouched", () => {
    putOldBlob("legit")
    const { blobsDir } = casPaths(base)
    // ① 分片目录里混进的异名文件(用户手滑/未知来源)。
    const stray = path.join(blobsDir, "zz-notes.txt")
    fs.writeFileSync(stray, "user note")
    fs.utimesSync(stray, OLD, OLD)
    // ② 名字过 pattern 但其实是 symlink 的条目(指向用户文件)。
    const userFile = path.join(base, "user-data.txt")
    fs.writeFileSync(userFile, "precious")
    const fakeDigest = sha("precious")
    const linkPath = casBlobPath(base, fakeDigest)!
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(userFile, linkPath)
    // ③ 环境根的用户文件树(GC 的 mark 只读,绝不写)。
    const userTree = path.join(envRoot, "workspace", "notes.md")
    fs.mkdirSync(path.dirname(userTree), { recursive: true })
    fs.writeFileSync(userTree, "user content")

    const r = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(r.ok).toBeTrue()
    expect(fs.existsSync(stray)).toBeTrue()
    expect(fs.existsSync(linkPath)).toBeTrue()
    expect(fs.readFileSync(userFile, "utf8")).toBe("precious")
    expect(fs.readFileSync(userTree, "utf8")).toBe("user content")
    expect(r.warnings.filter((w) => w.includes("not blob-owned")).length).toBeGreaterThanOrEqual(2)
  })

  test("shard-digest inconsistency (renamed blob) is kept + loud, never deleted", () => {
    const content = "misfiled"
    const digest = sha(content)
    // 放进错误分片(名字合法但与所在分片不符)——双守卫必须保留。
    const wrongShard = digest.slice(0, 2) === "aa" ? "bb" : "aa"
    const { blobsDir } = casPaths(base)
    const misfiled = path.join(blobsDir, wrongShard, digest)
    fs.mkdirSync(path.dirname(misfiled), { recursive: true })
    fs.writeFileSync(misfiled, content)
    fs.utimesSync(misfiled, OLD, OLD)
    const r = collectCasGarbage(base, { envRoots: [envRoot] })
    expect(r.ok).toBeTrue()
    expect(fs.existsSync(misfiled)).toBeTrue()
    expect(r.warnings.some((w) => w.includes(misfiled))).toBeTrue()
  })
})

describe("defaultCasGcEnvRoots", () => {
  test("covers dev(base) + prod + beta per REQ-098 domain split", () => {
    expect(defaultCasGcEnvRoots("/home/u/.alpha")).toEqual([
      "/home/u/.alpha",
      path.join("/home/u/.alpha", "env", "prod"),
      path.join("/home/u/.alpha", "env", "beta"),
    ])
  })
})
