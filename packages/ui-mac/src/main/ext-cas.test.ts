// REQ-102 A —— CAS 核心单测:digest 寻址/幂等/原子写、digest 不符 fail-closed(零副作用)、
// 读取重验(损坏 loud 拒绝)、symlink 拒绝、materialize 圈禁。全部真盘临时目录、零 mock(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  casBlobPath,
  casPaths,
  hasCasBlob,
  materializeFilesFromCas,
  pinCasBlob,
  populateFromCas,
  putCasBlobFromBuffer,
  putCasBlobFromFile,
  readCasBlobVerified,
  readCasPins,
  readCasPinsStrict,
  unpinCasBlob,
} from "./ext-cas"

let base: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-cas-"))
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex")

describe("casBlobPath", () => {
  test("addresses by digest with 2-char shard; rejects malformed digests", () => {
    const digest = sha("hello")
    const p = casBlobPath(base, digest)
    expect(p).toBe(path.join(base, "cas", "v1", "sha256", digest.slice(0, 2), digest))
    expect(casBlobPath(base, "ABC")).toBeNull()
    expect(casBlobPath(base, digest.toUpperCase())).toBeNull() // 大写不是 canonical
    expect(casBlobPath(base, `${digest.slice(0, 62)}/x`)).toBeNull() // 路径注入无通道
  })
})

describe("putCasBlobFromBuffer", () => {
  test("stores verified bytes atomically and is idempotent", () => {
    const data = Buffer.from("media-type-neutral bytes \x00\x01")
    const digest = sha(data)
    const first = putCasBlobFromBuffer(base, data, digest)
    expect(first.ok).toBeTrue()
    if (!first.ok) return
    expect(first.existed).toBeFalse()
    expect(fs.readFileSync(first.path)).toEqual(data)

    const again = putCasBlobFromBuffer(base, data, digest)
    expect(again.ok && again.existed).toBeTrue()
  })

  test("digest mismatch is fail-closed with ZERO side effects", () => {
    const data = Buffer.from("payload")
    const wrong = sha("other")
    const r = putCasBlobFromBuffer(base, data, wrong)
    expect(r.ok).toBeFalse()
    if (r.ok) return
    expect(r.reason).toContain("MISMATCH")
    expect(fs.existsSync(casPaths(base).blobsDir)).toBeFalse() // 连目录都不建
  })

  test("replaces a corrupt existing blob with verified bytes (loud warning)", () => {
    const data = Buffer.from("good bytes")
    const digest = sha(data)
    const dest = casBlobPath(base, digest)!
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, "corrupted")
    const r = putCasBlobFromBuffer(base, data, digest)
    expect(r.ok).toBeTrue()
    if (!r.ok) return
    expect(r.warnings.some((w) => w.includes("CORRUPT"))).toBeTrue()
    expect(fs.readFileSync(dest)).toEqual(data)
  })
})

describe("putCasBlobFromFile", () => {
  test("imports a regular file after re-hashing", () => {
    const src = path.join(base, "src.bin")
    const data = Buffer.from("from file")
    fs.writeFileSync(src, data)
    const r = putCasBlobFromFile(base, src, { sha256: sha(data), bytes: data.length })
    expect(r.ok).toBeTrue()
    expect(hasCasBlob(base, sha(data))).toBeTrue()
  })

  test("refuses symlink sources (fail closed)", () => {
    const real = path.join(base, "real.bin")
    fs.writeFileSync(real, "x")
    const link = path.join(base, "link.bin")
    fs.symlinkSync(real, link)
    const r = putCasBlobFromFile(base, link, { sha256: sha("x") })
    expect(r.ok).toBeFalse()
    if (!r.ok) expect(r.reason).toContain("symlink")
  })

  test("declared-size mismatch refuses before hashing", () => {
    const src = path.join(base, "s.bin")
    fs.writeFileSync(src, "abc")
    const r = putCasBlobFromFile(base, src, { sha256: sha("abc"), bytes: 999 })
    expect(r.ok).toBeFalse()
    if (!r.ok) expect(r.reason).toContain("size MISMATCH")
  })

  test("missing source refuses", () => {
    const r = putCasBlobFromFile(base, path.join(base, "nope"), { sha256: sha("x") })
    expect(r.ok).toBeFalse()
  })
})

describe("readCasBlobVerified", () => {
  test("re-verifies on read; on-disk corruption is refused loudly", () => {
    const data = Buffer.from("verify me")
    const digest = sha(data)
    expect(putCasBlobFromBuffer(base, data, digest).ok).toBeTrue()
    const good = readCasBlobVerified(base, digest)
    expect(good.ok && good.data.equals(data)).toBeTrue()

    fs.writeFileSync(casBlobPath(base, digest)!, "tampered")
    const bad = readCasBlobVerified(base, digest)
    expect(bad.ok).toBeFalse()
    if (!bad.ok) expect(bad.reason).toContain("CORRUPT")
  })

  test("symlinked CAS entry is refused", () => {
    const data = Buffer.from("aliased")
    const digest = sha(data)
    const outside = path.join(base, "outside.bin")
    fs.writeFileSync(outside, data)
    const dest = casBlobPath(base, digest)!
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(outside, dest)
    const r = readCasBlobVerified(base, digest)
    expect(r.ok).toBeFalse()
    if (!r.ok) expect(r.reason).toContain("not a regular file")
  })
})

describe("pins", () => {
  test("pin/unpin round-trips and ignores malformed entries", () => {
    const digest = sha("pin me")
    expect(pinCasBlob(base, digest, "release baseline")).toBeTrue()
    expect(readCasPins(base).pins[digest]?.reason).toBe("release baseline")
    expect(unpinCasBlob(base, digest)).toBeTrue()
    expect(Object.keys(readCasPins(base).pins)).toHaveLength(0)
    expect(pinCasBlob(base, "not-a-digest", "x")).toBeFalse()
  })

  test("readCasPinsStrict distinguishes missing / valid / invalid (REQ-102 #333)", () => {
    const { pinsPath } = casPaths(base)
    // 无文件 = 合法空集
    expect(readCasPinsStrict(base).status).toBe("missing")
    // 合法
    const digest = sha("strict pin")
    expect(pinCasBlob(base, digest, "keep")).toBeTrue()
    const valid = readCasPinsStrict(base)
    expect(valid.status).toBe("valid")
    if (valid.status === "valid") expect(valid.pins[digest]?.reason).toBe("keep")
    // JSON 损坏 = invalid,绝不降级空集
    fs.writeFileSync(pinsPath, "{broken")
    expect(readCasPinsStrict(base).status).toBe("invalid")
    // readCasPins 便利读遇损坏必须抛错(不静默空集)
    expect(() => readCasPins(base)).toThrow()
    // 条目 schema 非法(digest key 非法)= invalid
    fs.writeFileSync(pinsPath, JSON.stringify({ v: 1, pins: { "bad-key": { reason: "x", pinnedAt: "t" } } }))
    expect(readCasPinsStrict(base).status).toBe("invalid")
  })

  test("pin/unpin refuse to overwrite a corrupt pins ledger (REQ-102 #333)", () => {
    const { pinsPath } = casPaths(base)
    const digest = sha("do not clobber")
    fs.mkdirSync(path.dirname(pinsPath), { recursive: true })
    fs.writeFileSync(pinsPath, "{corrupt")
    // 损坏账本不得被「空集 + 本次一条」覆盖 —— 否则已有保护标记永久丢失
    expect(pinCasBlob(base, digest, "x")).toBeFalse()
    expect(unpinCasBlob(base, digest)).toBeFalse()
    expect(fs.readFileSync(pinsPath, "utf8")).toBe("{corrupt")
  })
})

describe("materializeFilesFromCas", () => {
  test("materializes a verified manifest into destination", () => {
    const a = Buffer.from("file a")
    const b = Buffer.from("file b")
    putCasBlobFromBuffer(base, a, sha(a))
    putCasBlobFromBuffer(base, b, sha(b))
    const dest = path.join(base, "staging")
    materializeFilesFromCas(
      base,
      [
        { path: "SKILL.md", sha256: sha(a), size: a.length },
        { path: "nested/dir/asset.bin", sha256: sha(b) },
      ],
      dest,
    )
    expect(fs.readFileSync(path.join(dest, "SKILL.md"))).toEqual(a)
    expect(fs.readFileSync(path.join(dest, "nested/dir/asset.bin"))).toEqual(b)
  })

  test("traversal / absolute paths / missing blob / corrupt blob all throw (fail closed)", () => {
    const data = Buffer.from("z")
    const digest = sha(data)
    putCasBlobFromBuffer(base, data, digest)
    const dest = path.join(base, "out")
    expect(() => materializeFilesFromCas(base, [{ path: "../escape", sha256: digest }], dest)).toThrow("unsafe file path")
    expect(() => materializeFilesFromCas(base, [{ path: "/abs", sha256: digest }], dest)).toThrow("unsafe file path")
    expect(() => materializeFilesFromCas(base, [{ path: "ok.txt", sha256: sha("missing") }], dest)).toThrow("not in store")
    fs.writeFileSync(casBlobPath(base, digest)!, "tampered")
    expect(() => materializeFilesFromCas(base, [{ path: "ok.txt", sha256: digest }], dest)).toThrow("CORRUPT")
  })

  test("populateFromCas adapts to the transaction populate hook shape", () => {
    const data = Buffer.from("hook payload")
    const digest = sha(data)
    putCasBlobFromBuffer(base, data, digest)
    const staging = path.join(base, "tx-staging")
    populateFromCas(base)({ files: [{ path: "f.txt", sha256: digest }] }, staging)
    expect(fs.readFileSync(path.join(staging, "f.txt"))).toEqual(data)
  })
})
