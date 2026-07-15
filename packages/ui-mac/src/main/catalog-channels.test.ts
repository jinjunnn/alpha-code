// REQ-101 A 侧单测/合同测试 —— signed channel metadata 验证机器(catalog-channels.ts,issue #193)。
//
// 两部分:
//   1. B 侧 testvectors 合同测试(testvectors/catalog-channels/,来源 alpha-web@6a11567,见 SOURCE.md):
//      vectors.json 的 expected 逐条断言;负向(tampered/expired/mix-and-match + snapshot 三型)必须拒绝。
//   2. 合成宇宙拒绝矩阵:测试内生成 ed25519 钥,覆盖 R1/R4/R5/R6/R7/R8/R9/R10/R11 + keyId 绑定 +
//      轮换窗口 + revoked 钥对缓存生效 + last-known-good(loud)+ 缓存重验签。
//
// main 进程测试纪律:无 mock.module;fetch/now/信任根/baseUrl 全参数 DI;缓存走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  catalogVersionLess,
  channelStatePath,
  keyIdOfSpkiDerB64,
  lookupSigningKey,
  readCachedTrust,
  readChannelLastKnownGood,
  readRevokedTargets,
  refreshChannelCatalog,
  revokedTargetEntry,
  sha256Hex,
  validateChannelDoc,
  validateTrustDoc,
  verifyChannelBytes,
  verifyEd25519,
  type ChannelClientDeps,
  type TrustDoc,
} from "./catalog-channels"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const BASE = "https://channels.test/catalog/v1"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-channels-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── DI 网络面:URL → 字节 的静态路由(404 兜底);记录请求序列 ────────────────────────────────
function serve(map: Record<string, string>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const hit = map[url]
    return hit === undefined ? new Response("not found", { status: 404 }) : new Response(hit)
  }) as typeof fetch
  return { fetchImpl, calls }
}

// ── 合成签名宇宙 ──────────────────────────────────────────────────────────────────────────────
type TestKey = { keyId: string; publicKeyB64: string; privateKey: crypto.KeyObject }
function genKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer
  return { keyId: crypto.createHash("sha256").update(der).digest("hex"), publicKeyB64: der.toString("base64"), privateKey }
}
const signB64 = (body: string, key: TestKey) => crypto.sign(null, Buffer.from(body, "utf8"), key.privateKey).toString("base64")

const keyEntry = (k: TestKey, over: Record<string, unknown> = {}) => ({
  keyId: k.keyId,
  publicKey: k.publicKeyB64,
  status: "active",
  notBefore: "2026-01-01T00:00:00.000Z",
  ...over,
})

function trustDoc(signer: TestKey, over: Record<string, unknown> = {}) {
  const body = JSON.stringify(
    {
      schema: "alpha.catalog.trust.v1",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-12-31T00:00:00.000Z",
      keyId: signer.keyId,
      keys: [keyEntry(signer)],
      revokedTargets: [],
      ...over,
    },
    null,
    2,
  )
  return { body, sig: signB64(body, signer) }
}

const payloadOf = (version: string, marker = "m") =>
  JSON.stringify({ version, entries: [{ id: `skill:${marker}` }] }, null, 2)

function channelDoc(
  signer: TestKey,
  payloadBody: string,
  over: Record<string, unknown> = {},
  targetOver: Record<string, unknown> = {},
) {
  const version = (JSON.parse(payloadBody) as { version: string }).version
  const body = JSON.stringify(
    {
      schema: "alpha.catalog.channel-metadata.v1",
      channel: "stable",
      sequence: 5,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-08-12T00:00:00.000Z",
      keyId: signer.keyId,
      target: {
        catalogVersion: version,
        sha256: sha256Hex(payloadBody),
        bytes: Buffer.byteLength(payloadBody),
        url: `${BASE}/releases/${version}/catalog.json`,
        sigUrl: `${BASE}/releases/${version}/catalog.json.sig`,
        ...targetOver,
      },
      ...over,
    },
    null,
    2,
  )
  return { body, sig: signB64(body, signer) }
}

/** #314:签名 snapshot,精确钉住给定成员文档的字节 + sequence(R13 一致性)。 */
let snapSeq = 100 // 单调:等序异字节 = R5 replacement,连续世界必须逐份递增
function snapshotDoc(signer: TestKey, members: Record<string, { body: string }>, over: Record<string, unknown> = {}) {
  const entries: Record<string, { sequence: number; sha256: string }> = {}
  for (const [name, m] of Object.entries(members)) {
    entries[name] = { sequence: (JSON.parse(m.body) as { sequence: number }).sequence, sha256: sha256Hex(m.body) }
  }
  const body = JSON.stringify(
    {
      schema: "alpha.catalog.snapshot.v1",
      sequence: ++snapSeq,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-08-12T00:00:00.000Z",
      keyId: signer.keyId,
      entries,
      ...over,
    },
    null,
    2,
  )
  return { body, sig: signB64(body, signer) }
}

/** 全套端点路由:trust + snapshot(#314,钉住 trust/stable)+ stable 指针 + payload
 *  (payload 签名者可与指针签名者不同,轮换用;snapshot 签名者可显式覆盖)。 */
function worldRoutes(
  trust: { body: string; sig: string },
  doc: { body: string; sig: string },
  payloadBody: string,
  payloadSigner: TestKey,
  opts: { snapshot?: { body: string; sig: string }; snapshotSigner?: TestKey } = {},
): Record<string, string> {
  const version = (JSON.parse(payloadBody) as { version: string }).version
  const snap = opts.snapshot ?? snapshotDoc(opts.snapshotSigner ?? payloadSigner, { trust, stable: doc })
  return {
    [`${BASE}/channels/trust.json`]: trust.body,
    [`${BASE}/channels/trust.json.sig`]: trust.sig,
    [`${BASE}/channels/snapshot.json`]: snap.body,
    [`${BASE}/channels/snapshot.json.sig`]: snap.sig,
    [`${BASE}/channels/stable.json`]: doc.body,
    [`${BASE}/channels/stable.json.sig`]: doc.sig,
    [`${BASE}/releases/${version}/catalog.json`]: payloadBody,
    [`${BASE}/releases/${version}/catalog.json.sig`]: signB64(payloadBody, payloadSigner),
  }
}

const depsOf = (fetchImpl: typeof fetch, builtin: TestKey): ChannelClientDeps => ({
  fetchImpl,
  now: () => NOW,
  baseUrl: BASE,
  builtinKeyB64: builtin.publicKeyB64,
})

/** 建立一份健康的 last-known-good(seq 5,version 2.0.0)并断言成功。 */
async function seedLkg(k1: TestKey, over: Record<string, unknown> = {}) {
  const trust = trustDoc(k1, over)
  const payload = payloadOf("2.0.0")
  const doc = channelDoc(k1, payload)
  const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
  const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
  expect(r.source).toBe("remote")
  return { trust, payload, doc }
}

// ══ Part 1:B 侧 testvectors 合同测试(来源 alpha-web@6a11567,#35 snapshot 向量集)═══════════════════════════════

const VEC_DIR = path.join(import.meta.dir, "testvectors", "catalog-channels")
const vecStr = (f: string) => fs.readFileSync(path.join(VEC_DIR, f), "utf8")
const vectors = JSON.parse(vecStr("vectors.json")) as {
  signingPublicKeySpkiDerB64: string
  keyId: string
  payload: { file: string; sha256: string; bytes: number; sigFile: string }
}
const VEC_KEY_B64 = vecStr("signing-key.pub.b64").trim()

/** vectors 宇宙:channels 面挂在 VEC_BASE;payload 面按 stable.json.target.url 的**绝对地址**路由。 */
const VEC_BASE = "https://vectors.test/catalog/v1"
function vectorRoutes(stableFile: string, snapshotFile = "snapshot.json"): Record<string, string> {
  return {
    [`${VEC_BASE}/channels/trust.json`]: vecStr("trust.json"),
    [`${VEC_BASE}/channels/trust.json.sig`]: vecStr("trust.json.sig"),
    [`${VEC_BASE}/channels/snapshot.json`]: vecStr(snapshotFile),
    [`${VEC_BASE}/channels/snapshot.json.sig`]: vecStr(`${snapshotFile}.sig`),
    [`${VEC_BASE}/channels/stable.json`]: vecStr(stableFile),
    [`${VEC_BASE}/channels/stable.json.sig`]: vecStr(`${stableFile}.sig`),
    "https://alphacodeone.com/catalog/v1/releases/9.9.9/catalog.json": vecStr("payload.catalog.json"),
    "https://alphacodeone.com/catalog/v1/releases/9.9.9/catalog.json.sig": vecStr("payload.catalog.json.sig"),
  }
}
const vecDeps = (fetchImpl: typeof fetch): ChannelClientDeps => ({
  fetchImpl,
  now: () => NOW,
  baseUrl: VEC_BASE,
  builtinKeyB64: VEC_KEY_B64,
})

describe("testvectors 合同(B 侧 @6a11567,含 snapshot)", () => {
  test("keyId 推导 = 公钥 SPKI DER 的 sha256(vectors.json 钉住)", () => {
    expect(vectors.signingPublicKeySpkiDerB64).toBe(VEC_KEY_B64)
    expect(keyIdOfSpkiDerB64(VEC_KEY_B64)).toBe(vectors.keyId)
  })

  test("payload 向量:digest/bytes 与索引一致,签名 verify=true", () => {
    const body = Buffer.from(vecStr("payload.catalog.json"), "utf8")
    expect(sha256Hex(body)).toBe(vectors.payload.sha256)
    expect(body.length).toBe(vectors.payload.bytes)
    expect(verifyEd25519(body, vecStr("payload.catalog.json.sig"), VEC_KEY_B64)).toBe(true)
  })

  test("trust 向量:schema 过;revoked 钥 9999… 拒取用;revokedTargets 含 dddd…", () => {
    const v = validateTrustDoc(JSON.parse(vecStr("trust.json")))
    expect(v.ok).toBe(true)
    const trust = (v as { ok: true; doc: TrustDoc }).doc
    const revokedKey = lookupSigningKey(trust, "9".repeat(64), NOW, { requireWindow: false })
    expect(revokedKey.ok).toBe(false)
    expect((revokedKey as { ok: false; error: string }).error).toContain("REVOKED")
    expect(revokedTargetEntry(trust, "d".repeat(64))).not.toBeNull()
    expect(revokedTargetEntry(trust, "e".repeat(64))).toBeNull()
    // 以 revoked keyId 自述的 channel 文档:验签之前就被 R10 拒绝
    const forged = JSON.stringify({ keyId: "9".repeat(64) })
    const r = verifyChannelBytes(Buffer.from(forged), "AAAA", "stable", trust, NOW, { requireUnexpired: true, requireWindow: true })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain("R10")
  })

  test("stable.json:全链路采信(source=remote,version 9.9.9,digest 钉合)", async () => {
    const { fetchImpl } = serve(vectorRoutes("stable.json"))
    const r = await refreshChannelCatalog(dir, "stable", vecDeps(fetchImpl))
    expect(r.source).toBe("remote")
    if (r.source !== "remote") throw new Error("unreachable")
    expect(r.version).toBe("9.9.9")
    expect(r.sha256).toBe(vectors.payload.sha256)
    expect((r.catalog as { entries: Array<{ id: string }> }).entries[0]?.id).toBe("skill:vector-demo")
    expect(fs.existsSync(channelStatePath(dir))).toBe(true)
  })

  test("负向 stable.tampered.json:签名不过 MUST reject(R1,fail closed,不落缓存)", async () => {
    const { fetchImpl } = serve(vectorRoutes("stable.tampered.json"))
    const r = await refreshChannelCatalog(dir, "stable", vecDeps(fetchImpl))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R1")
    // 被拒内容绝不能变成 last-known-good
    const trust = (validateTrustDoc(JSON.parse(vecStr("trust.json"))) as { ok: true; doc: TrustDoc }).doc
    expect(readChannelLastKnownGood(dir, "stable", trust, NOW)).toBeNull()
  })

  test("负向 stable.expired.json:过期 MUST reject(R4)", async () => {
    const { fetchImpl } = serve(vectorRoutes("stable.expired.json"))
    const r = await refreshChannelCatalog(dir, "stable", vecDeps(fetchImpl))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R4")
  })

  test("负向 mixmatch.dev-as-stable.json:doc.channel=dev 冒充 stable MUST reject(R3)", async () => {
    const { fetchImpl } = serve(vectorRoutes("mixmatch.dev-as-stable.json"))
    const r = await refreshChannelCatalog(dir, "stable", vecDeps(fetchImpl))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R3")
    // #314:同一份文档按它自述的 dev 请求 —— 向量 snapshot 只钉 trust+stable,dev entry 缺失
    // = R13 拒(entry-less channel 一律拒,裁决语义);"文档本身可采信"由合成宇宙 dev 用例证明。
    const routes = vectorRoutes("stable.json")
    routes[`${VEC_BASE}/channels/dev.json`] = vecStr("mixmatch.dev-as-stable.json")
    routes[`${VEC_BASE}/channels/dev.json.sig`] = vecStr("mixmatch.dev-as-stable.json.sig")
    const { fetchImpl: f2 } = serve(routes)
    const asDev = await refreshChannelCatalog(dir, "dev", vecDeps(f2))
    expect(asDev.source).toBe("none")
    if (asDev.source !== "none") throw new Error("unreachable")
    expect(asDev.error).toContain("R13")
    expect(asDev.reasonClass).toBe("security")
  })

  test("last-known-good(向量):先采信 stable.json,再遇 tampered → 回退缓存且 loud", async () => {
    const { fetchImpl } = serve(vectorRoutes("stable.json"))
    expect((await refreshChannelCatalog(dir, "stable", vecDeps(fetchImpl))).source).toBe("remote")
    const { fetchImpl: bad } = serve(vectorRoutes("stable.tampered.json"))
    const r = await refreshChannelCatalog(dir, "stable", vecDeps(bad))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.version).toBe("9.9.9")
    expect(r.error ?? "").toContain("R1") // loud,不静默
  })
})

// ══ Part 2:合成宇宙拒绝矩阵(fail closed)═════════════════════════════════════════════════════

describe("拒绝矩阵(合成 ed25519 宇宙)", () => {
  test("happy path:采信 + 落缓存;重复 refresh 幂等且 payload 免重拉(digest 命中缓存)", async () => {
    const k1 = genKey()
    const { trust, payload, doc } = await seedLkg(k1)
    const second = serve(worldRoutes(trust, doc, payload, k1))
    const r2 = await refreshChannelCatalog(dir, "stable", depsOf(second.fetchImpl, k1))
    expect(r2.source).toBe("remote")
    if (r2.source !== "remote") throw new Error("unreachable")
    expect(r2.version).toBe("2.0.0")
    expect(r2.error).toBeUndefined()
    expect(second.calls.some((u) => u.includes("/releases/"))).toBe(false) // payload 未重拉
  })

  test("R1:channel 文档字节被篡改 → 拒,无缓存则 source=none", async () => {
    const k1 = genKey()
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.0")
    const doc = channelDoc(k1, payload)
    const routes = worldRoutes(trust, doc, payload, k1)
    routes[`${BASE}/channels/stable.json`] = doc.body.replace("2026-07-13", "2026-07-12") // 动一字节
    const { fetchImpl } = serve(routes)
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R1")
  })

  test("R1(payload):payload 签名对不上字节 → 拒 → 回退 last-known-good,loud", async () => {
    const k1 = genKey()
    await seedLkg(k1)
    const trust = trustDoc(k1)
    const payload = payloadOf("2.1.0")
    const doc = channelDoc(k1, payload, { sequence: 6 })
    const routes = worldRoutes(trust, doc, payload, k1)
    routes[`${BASE}/releases/2.1.0/catalog.json.sig`] = signB64("something else entirely", k1)
    const { fetchImpl } = serve(routes)
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.version).toBe("2.0.0")
    expect(r.error).toContain("R1 payload")
  })

  test("R2:未知顶层键 → 拒(schema 严格)", async () => {
    const k1 = genKey()
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.0")
    const doc = channelDoc(k1, payload, { extraTopLevelKey: true })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R2")
    expect(r.error).toContain("extraTopLevelKey")
  })

  test("R4:channel 文档过期 → 拒 → last-known-good,loud", async () => {
    const k1 = genKey()
    await seedLkg(k1)
    const trust = trustDoc(k1)
    const payload = payloadOf("2.1.0")
    const doc = channelDoc(k1, payload, { sequence: 6, expires: "2026-07-13T11:59:59.000Z" })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.version).toBe("2.0.0")
    expect(r.error).toContain("R4")
  })

  test("R5:sequence 等值(不同字节)与降序都拒(重放/回滚)", async () => {
    const k1 = genKey()
    await seedLkg(k1) // seq 5
    for (const sequence of [5, 4]) {
      const trust = trustDoc(k1)
      const payload = payloadOf("2.1.0")
      const doc = channelDoc(k1, payload, { sequence, publishedAt: "2026-07-13T01:02:03.000Z" })
      const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
      const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
      expect(r.source).toBe("cache")
      if (r.source !== "cache") throw new Error("unreachable")
      expect(r.error).toContain("R5")
    }
  })

  test("R6:target.catalogVersion 低于 last-known(即便 sequence 更高)→ 拒", async () => {
    const k1 = genKey()
    await seedLkg(k1) // version 2.0.0
    const trust = trustDoc(k1)
    const payload = payloadOf("1.9.0")
    const doc = channelDoc(k1, payload, { sequence: 6 })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error).toContain("R6")
  })

  test("R7:同 catalogVersion 不同 sha256(内容替换)→ 拒", async () => {
    const k1 = genKey()
    await seedLkg(k1)
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.0", "replaced-content") // 同版本、不同字节 → 不同 digest
    const doc = channelDoc(k1, payload, { sequence: 6 })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error).toContain("R7")
  })

  test("R8:payload 字节与 target.sha256 不符 → 拒装", async () => {
    const k1 = genKey()
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.0")
    const doc = channelDoc(k1, payload, {}, { sha256: sha256Hex("some other payload") })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R8")
  })

  test("R9:payload.version ≠ target.catalogVersion(版本绑定)→ 拒装", async () => {
    const k1 = genKey()
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.1")
    const doc = channelDoc(k1, payload, {}, { catalogVersion: "2.0.0" }) // digest/bytes 仍指向 2.0.1 字节
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R9")
  })

  test("R10:unknown keyId / revoked 钥 / notBefore 未来 / notAfter 已过 全部拒", async () => {
    const k1 = genKey(),
      k2 = genKey()
    const payload = payloadOf("2.0.0")
    const cases: Array<{ keys: unknown[]; signer: TestKey; want: string }> = [
      { keys: [keyEntry(k1)], signer: k2, want: "unknown" }, // k2 未登记
      { keys: [keyEntry(k1), keyEntry(k2, { status: "revoked" })], signer: k2, want: "REVOKED" },
      { keys: [keyEntry(k1), keyEntry(k2, { notBefore: "2026-07-14T00:00:00.000Z" })], signer: k2, want: "window" },
      { keys: [keyEntry(k1), keyEntry(k2, { notAfter: "2026-07-13T00:00:00.000Z" })], signer: k2, want: "window" },
    ]
    for (const c of cases) {
      const sub = fs.mkdtempSync(path.join(os.tmpdir(), "cc-r10-"))
      try {
        const trust = trustDoc(k1, { keys: c.keys })
        const doc = channelDoc(c.signer, payload)
        const { fetchImpl } = serve(worldRoutes(trust, doc, payload, c.signer))
        const r = await refreshChannelCatalog(sub, "stable", depsOf(fetchImpl, k1))
        expect(r.source).toBe("none")
        if (r.source !== "none") throw new Error("unreachable")
        expect(r.error).toContain("R10")
        expect(r.error).toContain(c.want)
      } finally {
        fs.rmSync(sub, { recursive: true, force: true })
      }
    }
  })

  test("R10 绑定:登记表里 keyId 冒名(keyId ≠ sha256(publicKey))→ 取用即拒", async () => {
    const k1 = genKey(),
      k2 = genKey(),
      k3 = genKey()
    const payload = payloadOf("2.0.0")
    // 登记表声称 k2.keyId,公钥却是 k3 的;攻击者用 k3 签名并自述 keyId=k2
    const trust = trustDoc(k1, { keys: [keyEntry(k1), { ...keyEntry(k3), keyId: k2.keyId }] })
    const doc = channelDoc(k3, payload, { keyId: k2.keyId })
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("binding")
  })

  test("R11:target digest 在 revokedTargets → 拒(即便签名/schema 全过)", async () => {
    const k1 = genKey()
    const payload = payloadOf("2.0.0")
    const trust = trustDoc(k1, {
      revokedTargets: [{ sha256: sha256Hex(payload), reason: "compromised", revokedAt: "2026-07-13T00:00:00.000Z" }],
    })
    const doc = channelDoc(k1, payload)
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R11")
  })

  test("R11 对已缓存内容生效:新 trust 撤销 last-known-good 的 digest → 缓存也拒,source=none", async () => {
    const k1 = genKey()
    const { payload } = await seedLkg(k1)
    // 新 trust(seq 2)撤销已缓存 payload;指针仍指旧 digest
    const trust2 = trustDoc(k1, {
      sequence: 2,
      revokedTargets: [{ sha256: sha256Hex(payload), reason: "pulled", revokedAt: "2026-07-13T06:00:00.000Z" }],
    })
    const doc = channelDoc(k1, payload, { sequence: 6 })
    const { fetchImpl } = serve(worldRoutes(trust2, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none") // 新状态 R11 拒 + LKG 同 digest 也被撤 → 无可回退
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R11")
    // 撤销离线持久:trust 已先行落盘,断网也能查到
    expect(readRevokedTargets(dir, { now: () => NOW, builtinKeyB64: k1.publicKeyB64 }).get(sha256Hex(payload))).toBe("pulled")
  })

  test("revoked 钥的一切文档失效(含缓存):LKG 由被撤钥签名 → 不作回退,source=none", async () => {
    const k1 = genKey(),
      k2 = genKey()
    await seedLkg(k1, { keys: [keyEntry(k1), keyEntry(k2)] }) // LKG 文档/payload 由 k1 签
    // 新 trust:k1 revoked(k2 接管);channel 端点断网(404)
    const trust2 = trustDoc(k2, { sequence: 2, keys: [keyEntry(k1, { status: "revoked" }), keyEntry(k2)] })
    const { fetchImpl } = serve({
      [`${BASE}/channels/trust.json`]: trust2.body,
      [`${BASE}/channels/trust.json.sig`]: trust2.sig,
    })
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error.length).toBeGreaterThan(0)
  })

  test("key rotation 全流程:引钥(双活窗口)→ 新钥签发采信 → 链上 trust 换签者 → 撤旧钥后旧钥文档拒", async () => {
    const k1 = genKey(), // 内置信任根
      k2 = genKey()
    // T1:只有 k1
    await seedLkg(k1) // seq 5, 2.0.0(k1 签)
    // T2(k1 签,seq 2):引入 k2,k1 retiring 窗口未到期;指针/以及 payload 均换 k2 重签(字节不动)
    const trust2 = trustDoc(k1, {
      sequence: 2,
      keys: [keyEntry(k1, { status: "retiring", notAfter: "2026-09-01T00:00:00.000Z" }), keyEntry(k2)],
    })
    const payload = payloadOf("2.0.0")
    const doc6 = channelDoc(k2, payload, { sequence: 6 })
    const w2 = serve(worldRoutes(trust2, doc6, payload, k2))
    const r2 = await refreshChannelCatalog(dir, "stable", depsOf(w2.fetchImpl, k1))
    expect(r2.source).toBe("remote")
    if (r2.source !== "remote") throw new Error("unreachable")
    expect(r2.version).toBe("2.0.0")
    // T3(k2 签,seq 3):trust 换新钥签名 —— 经缓存 T2 的单级链验证;并撤销 k1
    const trust3 = trustDoc(k2, {
      sequence: 3,
      keyId: k2.keyId,
      keys: [keyEntry(k1, { status: "revoked" }), keyEntry(k2)],
    })
    const doc7 = channelDoc(k2, payload, { sequence: 7 })
    const w3 = serve(worldRoutes(trust3, doc7, payload, k2))
    const r3 = await refreshChannelCatalog(dir, "stable", depsOf(w3.fetchImpl, k1))
    expect(r3.source).toBe("remote")
    // 重启等价:缓存 trust 经 锚(T2,内置钥直验)→ 链(T3,k2 签)重验仍可用,序列=3
    const cached = readCachedTrust(dir, k1.publicKeyB64, NOW)
    expect(cached?.doc.sequence).toBe(3)
    // 撤销生效:再来一份 k1 签的指针(seq 8)→ R10 REVOKED → 回退 LKG(k2 签的 seq 7)
    const doc8 = channelDoc(k1, payload, { sequence: 8 })
    const w4 = serve(worldRoutes(trust3, doc8, payload, k1))
    const r4 = await refreshChannelCatalog(dir, "stable", depsOf(w4.fetchImpl, k1))
    expect(r4.source).toBe("cache")
    if (r4.source !== "cache") throw new Error("unreachable")
    expect(r4.error).toContain("REVOKED")
  })

  test("trust 自锁:trust 文档撤销自己的签名钥 → 该 trust 被拒,沿用缓存 trust", async () => {
    const k1 = genKey()
    const { payload, doc } = await seedLkg(k1)
    const selfRevoked = trustDoc(k1, { sequence: 2, keys: [keyEntry(k1, { status: "revoked" })] })
    const { fetchImpl } = serve(worldRoutes(selfRevoked, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    // #314:自锁 trust 被拒 → 沿用缓存 trust;但服务端 snapshot 钉的是被拒 trust = 偏斜,
    // R13 security → LKG(fail-closed:偏斜集合不采信新指针)。
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error ?? "").toContain("R13")
    expect(r.reasonClass).toBe("security")
  })

  test("R5(trust):trust sequence 回退 → 拒新 trust,沿用缓存,loud notice", async () => {
    const k1 = genKey()
    await seedLkg(k1, { sequence: 3 })
    const older = trustDoc(k1, { sequence: 2, publishedAt: "2026-07-12T00:00:00.000Z" })
    const payload = payloadOf("2.0.0")
    const doc = channelDoc(k1, payload, { sequence: 6 })
    const { fetchImpl } = serve(worldRoutes(older, doc, payload, k1))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    // #314:旧 trust 被拒(R5,loud notice 保留)→ 沿用缓存 trust;snapshot 钉旧 trust = 偏斜
    // → R13 security → LKG。
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error ?? "").toContain("R13")
    expect(r.reasonClass).toBe("security")
  })

  test("R4(trust):缓存 trust 已过期 → 不锚定新状态,只回退 last-known-good,loud", async () => {
    const k1 = genKey()
    await seedLkg(k1)
    // 手工把缓存里的 trust 换成一份已过期(但签名有效)的 —— 模拟长期离线后的状态
    const expired = trustDoc(k1, { sequence: 4, expires: "2026-07-13T00:00:00.000Z" })
    const st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    st.trust = { body: expired.body, sig: expired.sig }
    st.trustAnchor = { body: expired.body, sig: expired.sig }
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    const { fetchImpl } = serve({}) // 全 404:trust 拉不到新的
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.version).toBe("2.0.0")
    expect(r.error).toContain("R4 trust EXPIRED")
  })

  test("缓存重验签:state 文件被本地篡改 → trust/LKG 全部丢弃(fail closed)", async () => {
    const k1 = genKey()
    const { trust } = await seedLkg(k1)
    const st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    st.trust.body = st.trust.body.replace("alpha.catalog.trust.v1", "alpha.catalog.trust.v1 ")
    st.trustAnchor = st.trust
    st.channels.stable.payload.body = st.channels.stable.payload.body.replace("skill:m", "skill:x")
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    expect(readCachedTrust(dir, k1.publicKeyB64, NOW)).toBeNull()
    const trustDocParsed = (validateTrustDoc(JSON.parse(trust.body)) as { ok: true; doc: TrustDoc }).doc
    expect(readChannelLastKnownGood(dir, "stable", trustDocParsed, NOW)).toBeNull()
  })

  test("无 trust(无缓存 + 拉取失败)→ fail closed,source=none", async () => {
    const k1 = genKey()
    const { fetchImpl } = serve({})
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("fail closed")
  })
})

// ══ Part 3:基础件单测 ═══════════════════════════════════════════════════════════════════════

describe("基础件", () => {
  test("catalogVersionLess:段内数值感知(合同 §4,与 B 侧 versionLess 逐字一致)", () => {
    expect(catalogVersionLess("2026-07-05.9", "2026-07-05.10")).toBe(true)
    expect(catalogVersionLess("2026-07-05.10", "2026-07-05.9")).toBe(false)
    expect(catalogVersionLess("2.0.0", "2.0.0")).toBe(false)
    expect(catalogVersionLess("1.9.0", "2.0.0")).toBe(true)
  })

  test("validateChannelDoc:target 未知键 / 非 https url / channel 枚举外 都拒", () => {
    const good = JSON.parse(vecStr("stable.json"))
    expect(validateChannelDoc(good).ok).toBe(true)
    const t1 = structuredClone(good)
    t1.target.mirror = "https://evil.example/x.json"
    expect(validateChannelDoc(t1).ok).toBe(false)
    const t2 = structuredClone(good)
    t2.target.url = "http://alphacodeone.com/catalog/v1/x.json"
    expect(validateChannelDoc(t2).ok).toBe(false)
    const t3 = structuredClone(good)
    t3.channel = "nightly"
    expect(validateChannelDoc(t3).ok).toBe(false)
  })
})

// ══ Part 3:#314 snapshot 一致性(R13)+ 失败分类 ═══════════════════════════════════════════════

describe("#314 snapshot 一致性与 fail-closed 分类", () => {
  test("向量三负向:member-mismatch / entry-missing / sequence-mismatch → stable 拒(R13,security)", async () => {
    for (const snapFile of ["snapshot.member-mismatch.json", "snapshot.entry-missing.json", "snapshot.sequence-mismatch.json"]) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "snap-neg-"))
      const { fetchImpl } = serve(vectorRoutes("stable.json", snapFile))
      const r = await refreshChannelCatalog(d, "stable", vecDeps(fetchImpl))
      expect(r.source).toBe("none")
      if (r.source !== "none") throw new Error("unreachable")
      expect(r.error).toContain("R13")
      expect(r.reasonClass).toBe("security")
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  test("snapshot 缺失(404)→ security 拒;LKG 在场则回 LKG 并保留 R13 error", async () => {
    const k1 = genKey()
    const { trust, payload, doc } = await seedLkg(k1)
    const routes = worldRoutes(trust, doc, payload, k1)
    delete routes[`${BASE}/channels/snapshot.json`]
    delete routes[`${BASE}/channels/snapshot.json.sig`]
    const { fetchImpl } = serve(routes)
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error ?? "").toContain("R13")
    expect(r.reasonClass).toBe("security")
  })

  test("R5(snapshot):序列低于本 channel 缓存基线 → 拒;等序异字节(replacement)也拒", async () => {
    const k1 = genKey()
    const { trust, payload, doc } = await seedLkg(k1) // 缓存 snapshot seq = N
    const cachedSeq = (JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8")).channels.stable.snapshot &&
      (JSON.parse(JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8")).channels.stable.snapshot.body) as { sequence: number })
        .sequence) as number
    expect(Number.isInteger(cachedSeq)).toBe(true)
    // 序列回退
    const older = snapshotDoc(k1, { trust, stable: doc }, { sequence: cachedSeq - 1 })
    const r1 = await refreshChannelCatalog(dir, "stable", depsOf(serve(worldRoutes(trust, doc, payload, k1, { snapshot: older })).fetchImpl, k1))
    expect(r1.source).toBe("cache")
    if (r1.source !== "cache") throw new Error("unreachable")
    expect(r1.error ?? "").toContain("R5 snapshot")
    // 等序异字节(publishedAt 改动)
    const replaced = snapshotDoc(k1, { trust, stable: doc }, { sequence: cachedSeq, publishedAt: "2026-07-13T00:00:01.000Z" })
    const r2 = await refreshChannelCatalog(dir, "stable", depsOf(serve(worldRoutes(trust, doc, payload, k1, { snapshot: replaced })).fetchImpl, k1))
    expect(r2.source).toBe("cache")
    if (r2.source !== "cache") throw new Error("unreachable")
    expect(r2.error ?? "").toContain("R5 snapshot")
  })

  test("R13-on-cache:本地篡改缓存 doc(换成另一份合法签名文档)→ LKG 因与缓存 snapshot 失配被弃", async () => {
    const k1 = genKey()
    const { trust, payload } = await seedLkg(k1)
    // 用同钥签一份 seq 6 的合法 doc 换进缓存(签名有效,但 snapshot 钉的是 seq 5 的字节)
    const swapped = channelDoc(k1, payload, { sequence: 6 })
    const st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    st.channels.stable.doc = { body: swapped.body, sig: swapped.sig }
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    const lkg = readChannelLastKnownGood(dir, "stable", (JSON.parse(trust.body) as TrustDoc), NOW)
    expect(lkg).toBeNull()
  })

  test("dev 文档在 snapshot 钉住 dev entry 时可采信(证明 R3 拒的是 mix-and-match,不是文档本身)", async () => {
    const k1 = genKey()
    const trust = trustDoc(k1)
    const payload = payloadOf("2.0.0", "dev")
    const devDoc = channelDoc(k1, payload, { channel: "dev" })
    const snap = snapshotDoc(k1, { trust, dev: devDoc })
    const version = "2.0.0"
    const { fetchImpl } = serve({
      [`${BASE}/channels/trust.json`]: trust.body,
      [`${BASE}/channels/trust.json.sig`]: trust.sig,
      [`${BASE}/channels/snapshot.json`]: snap.body,
      [`${BASE}/channels/snapshot.json.sig`]: snap.sig,
      [`${BASE}/channels/dev.json`]: devDoc.body,
      [`${BASE}/channels/dev.json.sig`]: devDoc.sig,
      [`${BASE}/releases/${version}/catalog.json`]: payload,
      [`${BASE}/releases/${version}/catalog.json.sig`]: signB64(payload, k1),
    })
    const r = await refreshChannelCatalog(dir, "dev", depsOf(fetchImpl, k1))
    expect(r.source).toBe("remote")
  })

  test("readRevokedTargets:无可验 trust → null(撤销状态未知,不是空集)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rvk-null-"))
    const k = genKey()
    expect(readRevokedTargets(d, { now: () => NOW, builtinKeyB64: k.publicKeyB64 })).toBeNull()
    fs.rmSync(d, { recursive: true, force: true })
  })
})

describe("#314 review 回归:三态 grandfather / 等序空白字节 replacement", () => {
  test("缓存 snapshot 被破坏(invalid)→ LKG 拒;被删除且高水位已达 2 → LKG 拒", async () => {
    const k1 = genKey()
    const { trust } = await seedLkg(k1)
    const trustDocParsed = JSON.parse(trust.body) as TrustDoc
    // invalid:snapshot 位在场但字节被改(验签失败)
    let st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    expect(st.stateVersion).toBe(2)
    const goodSnapshot = st.channels.stable.snapshot
    st.channels.stable.snapshot = { body: goodSnapshot.body.replace("alpha.catalog.snapshot.v1", "alpha.catalog.snapshot.vX"), sig: goodSnapshot.sig }
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    expect(readChannelLastKnownGood(dir, "stable", trustDocParsed, NOW)).toBeNull()
    // absent + 高水位:删除 snapshot 位伪装 legacy → 拒
    st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    delete st.channels.stable.snapshot
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    expect(readChannelLastKnownGood(dir, "stable", trustDocParsed, NOW)).toBeNull()
    // absent + 真 pre-#314(stateVersion 1)→ grandfather 放行
    st = JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8"))
    st.stateVersion = 1
    fs.writeFileSync(channelStatePath(dir), JSON.stringify(st))
    expect(readChannelLastKnownGood(dir, "stable", trustDocParsed, NOW)).not.toBeNull()
  })

  test("R5(snapshot):等序、JSON 语义相同但仅空白/序列化不同的签名 snapshot → replacement 拒", async () => {
    const k1 = genKey()
    const { trust, payload, doc } = await seedLkg(k1)
    const cachedSnapBody = (JSON.parse(fs.readFileSync(channelStatePath(dir), "utf8")).channels.stable.snapshot as { body: string }).body
    // 同一 JSON 语义,不同字节(压缩序列化)+ 合法签名
    const compact = JSON.stringify(JSON.parse(cachedSnapBody))
    expect(compact).not.toBe(cachedSnapBody)
    const replaced = { body: compact, sig: signB64(compact, k1) }
    const { fetchImpl } = serve(worldRoutes(trust, doc, payload, k1, { snapshot: replaced }))
    const r = await refreshChannelCatalog(dir, "stable", depsOf(fetchImpl, k1))
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("unreachable")
    expect(r.error ?? "").toContain("R5 snapshot")
  })
})
