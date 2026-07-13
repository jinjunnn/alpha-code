// REQ-102 A(#194)—— packaged seed 快照漂移守卫(合同 §5 S13 的 A 侧形态)。
//
// resources/extension-seed 由 scripts/sync-extension-seed.mjs 从 alpha-web 已验签 stable 链
// 交叉复核生成,禁手编。本测试钉住:
//   · 入仓 lock 过消费端严格解码(ext-seed.decodeSeedLock —— 未知键/预算/许可/平台全门);
//   · lock/NOTICE 字节 sha256 与快照 meta 一致(手编即红);
//   · **与内置 catalog 快照互钉**:lock.catalog.sha256 == alpha-catalog.json 字节 sha256
//     (stable 晋级后只再生其一 → 红;两个快照必须同 stable target 同步再生);
//   · blob 目录与 lock 清单精确互等(缺一/多一/内容漂移/symlink 均红)——S11 逐字节重哈希;
//   · 真实消费链冒烟:readPackagedSeed(纯读)+ 逐兼容资产 verifySeedAsset + 单资产提升进
//     临时 CAS(两遍式全过)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { hasCasBlob } from "./ext-cas"
import { decodeSeedLock, promoteSeedAssetToCas, readPackagedSeed, verifySeedAsset } from "./ext-seed"

const seedDir = path.resolve(import.meta.dir, "../../resources/extension-seed")
const metaPath = path.join(seedDir, "extension-seed.snapshot.json")
const catalogPath = path.resolve(import.meta.dir, "../renderer/extensions/alpha-catalog.json")
const catalogMetaPath = path.resolve(import.meta.dir, "../renderer/extensions/alpha-catalog.snapshot.json")

const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex")
const PLATFORM = "darwin-arm64" // lock.supportedPlatforms 成员;逐资产兼容性在下方按资产判定

const lockBytes = fs.readFileSync(path.join(seedDir, "seed.lock.json"))
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
  v: number
  catalogVersion: string
  lockSha256: string
  noticeSha256: string
  blobCount: number
  blobBytes: number
}
const decoded = decodeSeedLock(lockBytes.toString("utf8"))

describe("extension-seed snapshot drift guard", () => {
  test("committed lock passes the strict consumer decoder", () => {
    expect(decoded.ok).toBeTrue()
  })

  test("lock/NOTICE bytes match snapshot meta (hand-edit turns red)", () => {
    expect(sha(lockBytes)).toBe(meta.lockSha256)
    expect(sha(fs.readFileSync(path.join(seedDir, "NOTICE.md")))).toBe(meta.noticeSha256)
    if (!decoded.ok) return
    expect(decoded.lock.catalogVersion).toBe(meta.catalogVersion)
  })

  test("cross-pin: lock.catalog == bundled catalog snapshot (both regenerate on stable promotion)", () => {
    if (!decoded.ok) return
    const catalogBytes = fs.readFileSync(catalogPath)
    expect(sha(catalogBytes)).toBe(decoded.lock.catalog.sha256)
    expect(catalogBytes.length).toBe(decoded.lock.catalog.bytes)
    const catalogMeta = JSON.parse(fs.readFileSync(catalogMetaPath, "utf8")) as { version: string; sha256: string }
    expect(catalogMeta.sha256).toBe(decoded.lock.catalog.sha256)
    expect(catalogMeta.version).toBe(decoded.lock.catalogVersion)
  })

  test("blob store equals the lock manifest exactly (S11 re-hash, zero extras, zero symlinks)", () => {
    if (!decoded.ok) return
    const expected = new Map<string, number>()
    for (const asset of decoded.lock.assets) for (const f of asset.files) expected.set(f.sha256, f.bytes)
    expect(expected.size).toBe(meta.blobCount)

    const blobsRoot = path.join(seedDir, "blobs", "sha256")
    const onDisk = new Set<string>()
    let diskBytes = 0
    for (const shard of fs.readdirSync(blobsRoot)) {
      const shardAbs = path.join(blobsRoot, shard)
      expect(/^[0-9a-f]{2}$/.test(shard)).toBeTrue()
      for (const name of fs.readdirSync(shardAbs)) {
        const abs = path.join(shardAbs, name)
        const st = fs.lstatSync(abs)
        expect(st.isSymbolicLink()).toBeFalse()
        expect(st.isFile()).toBeTrue()
        expect(name.startsWith(shard)).toBeTrue()
        expect(expected.has(name)).toBeTrue() // 多一即红
        expect(st.size).toBe(expected.get(name)!)
        expect(sha(fs.readFileSync(abs))).toBe(name) // 内容漂移即红
        onDisk.add(name)
        diskBytes += st.size
      }
    }
    expect(onDisk.size).toBe(expected.size) // 缺一即红
    expect(diskBytes).toBe(meta.blobBytes)
  })

  test("real consumption chain: browse (pure read) + per-asset verification + CAS promotion", () => {
    const read = readPackagedSeed(seedDir, { platformToken: PLATFORM })
    expect(read.ok).toBeTrue()
    if (!read.ok) return
    expect(read.seed.assets.length).toBeGreaterThan(0)
    expect(read.seed.noticePath).not.toBeNull()
    for (const asset of read.seed.assets) {
      if (!asset.platformCompatible) continue
      const verified = verifySeedAsset(seedDir, read.seed.lock, asset.id, { platformToken: PLATFORM })
      expect(verified.ok).toBeTrue()
    }
    const casBase = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-seed-snap-"))
    try {
      const first = read.seed.assets.find((a) => a.platformCompatible)!
      const promoted = promoteSeedAssetToCas(seedDir, read.seed.lock, first.id, casBase, { platformToken: PLATFORM })
      expect(promoted.ok).toBeTrue()
      if (promoted.ok) for (const f of promoted.files) expect(hasCasBlob(casBase, f.sha256)).toBeTrue()
    } finally {
      fs.rmSync(casBase, { recursive: true, force: true })
    }
  })
})
