// REQ-101 A 侧接线测试 —— refreshRemoteCatalog 的 channel-first + v1 零破坏回退(issue #193)。
//
// 断言面:① channel(stable)全链路过 → 走 channel;② channel 面不可用 → 现行 v1 语义
// (验签/ETag/缓存回退)逐项不变;③ R11 撤销对 v1 远端与 v1 缓存同样生效(离线可判);
// ④ v1 也失败时 channel last-known-good 兜底。纪律:无 mock.module,fetch/now/信任根 DI。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { refreshChannelCatalog, sha256Hex, type ChannelClientDeps } from "./catalog-channels"
import { readCachedCatalog, refreshRemoteCatalog } from "./remote-catalog"
import { registryChannelFor } from "./alpha-environment"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const CH_BASE = "https://channels.test/catalog/v1"
const V1_URL = "https://alphacodeone.com/catalog/v1/catalog.json" // 生产常量(v1 兼容面,不可注入 = 不动现网语义)

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-catalog-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type TestKey = { keyId: string; publicKeyB64: string; privateKey: crypto.KeyObject }
function genKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer
  return { keyId: crypto.createHash("sha256").update(der).digest("hex"), publicKeyB64: der.toString("base64"), privateKey }
}
const signB64 = (body: string, key: TestKey) => crypto.sign(null, Buffer.from(body, "utf8"), key.privateKey).toString("base64")

function serve(map: Record<string, string | ((headers: Record<string, string>) => Response)>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const hit = map[url]
    if (hit === undefined) return new Response("not found", { status: 404 })
    if (typeof hit === "function") return hit((init?.headers ?? {}) as Record<string, string>)
    return new Response(hit)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function trustBody(signer: TestKey, over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: "alpha.catalog.trust.v1",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-12-31T00:00:00.000Z",
      keyId: signer.keyId,
      keys: [{ keyId: signer.keyId, publicKey: signer.publicKeyB64, status: "active", notBefore: "2026-01-01T00:00:00.000Z" }],
      revokedTargets: [],
      ...over,
    },
    null,
    2,
  )
}

function channelBody(signer: TestKey, payloadBody: string, over: Record<string, unknown> = {}): string {
  const version = (JSON.parse(payloadBody) as { version: string }).version
  return JSON.stringify(
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
        url: `${CH_BASE}/releases/${version}/catalog.json`,
        sigUrl: `${CH_BASE}/releases/${version}/catalog.json.sig`,
      },
      ...over,
    },
    null,
    2,
  )
}

const payloadOf = (version: string, marker = "m") =>
  JSON.stringify({ version, entries: [{ id: `skill:${marker}` }] }, null, 2)

function channelRoutes(k: TestKey, payloadBody: string, trustOver: Record<string, unknown> = {}, channel = "stable"): Record<string, string> {
  const trust = trustBody(k, trustOver)
  const doc = channelBody(k, payloadBody, { channel })
  const version = (JSON.parse(payloadBody) as { version: string }).version
  return {
    [`${CH_BASE}/channels/trust.json`]: trust,
    [`${CH_BASE}/channels/trust.json.sig`]: signB64(trust, k),
    [`${CH_BASE}/channels/${channel}.json`]: doc,
    [`${CH_BASE}/channels/${channel}.json.sig`]: signB64(doc, k),
    [`${CH_BASE}/releases/${version}/catalog.json`]: payloadBody,
    [`${CH_BASE}/releases/${version}/catalog.json.sig`]: signB64(payloadBody, k),
  }
}

const depsOf = (fetchImpl: typeof fetch, k: TestKey): ChannelClientDeps => ({
  fetchImpl,
  now: () => NOW,
  baseUrl: CH_BASE,
  builtinKeyB64: k.publicKeyB64,
})

describe("refreshRemoteCatalog 接线(channel-first + v1 零破坏)", () => {
  test("channel(stable)全链路过 → via=channel-stable,采信已验 payload", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    const { fetchImpl } = serve(channelRoutes(k, payload))
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.version).toBe("2026-07-13.1")
  })

  test("channel 面不可用(端点 404)→ loud 回退现行 v1 路径:验签采信 + 落缓存", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    const { fetchImpl } = serve({
      [V1_URL]: v1,
      [`${V1_URL}.sig`]: signB64(v1, k),
    })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("v1")
    expect(r.version).toBe("2026-07-13.1")
    // v1 缓存语义不变:断网 → cache 回退(loud)
    const { fetchImpl: dead } = serve({})
    const r2 = await refreshRemoteCatalog(dir, "stable", depsOf(dead, k))
    expect(r2.source).toBe("cache")
    if (r2.source === "none") throw new Error("unreachable")
    expect(r2.via).toBe("v1")
    expect(r2.error ?? "").not.toBe("")
  })

  test("v1 ETag 304 语义不变(channel 面缺席时)", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    const sig = signB64(v1, k)
    const first = serve({
      [V1_URL]: () => new Response(v1, { headers: { etag: '"abc"' } }),
      [`${V1_URL}.sig`]: sig,
    })
    expect((await refreshRemoteCatalog(dir, "stable", depsOf(first.fetchImpl, k))).source).toBe("remote")
    const second = serve({
      [V1_URL]: (headers) =>
        headers["if-none-match"] === '"abc"' ? new Response(null, { status: 304 }) : new Response(v1, { headers: { etag: '"abc"' } }),
      [`${V1_URL}.sig`]: sig,
    })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(second.fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("v1")
    expect(r.version).toBe("2026-07-13.1")
  })

  test("v1 验签不过仍拒(SIGNATURE INVALID,现行语义)", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    const { fetchImpl } = serve({
      [V1_URL]: v1,
      [`${V1_URL}.sig`]: signB64("tampered bytes", k),
    })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("SIGNATURE INVALID")
  })

  test("R11 对 v1 远端生效:trust 撤销的 digest 即便签名有效也拒(离线用缓存 trust 判)", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    // 先经 channel 机器缓存一份撤销 v1 digest 的 trust(channel 指针缺席 → channel 面本身失败,但 trust 已先行落盘)
    const trust = trustBody(k, {
      revokedTargets: [{ sha256: sha256Hex(v1), reason: "supply-chain pull", revokedAt: "2026-07-13T00:00:00.000Z" }],
    })
    const seed = serve({
      [`${CH_BASE}/channels/trust.json`]: trust,
      [`${CH_BASE}/channels/trust.json.sig`]: signB64(trust, k),
    })
    expect((await refreshChannelCatalog(dir, "stable", depsOf(seed.fetchImpl, k))).source).toBe("none")
    // channel 面仍不可用;v1 远端给出被撤销的 payload(签名完全有效)→ 必须拒,fail closed
    const { fetchImpl } = serve({
      [V1_URL]: v1,
      [`${V1_URL}.sig`]: signB64(v1, k),
    })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.error).toContain("R11")
  })

  test("R11 对 v1 已缓存内容生效:readCachedCatalog 命中撤销 digest → 丢弃", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "remote-catalog.json"),
      JSON.stringify({ version: "2026-07-13.1", fetchedAt: "2026-07-13T00:00:00.000Z", body: v1, sig: signB64(v1, k) }),
    )
    const opts = { pubKeyB64: k.publicKeyB64 }
    expect(readCachedCatalog(dir, opts)).not.toBeNull()
    expect(readCachedCatalog(dir, { ...opts, revoked: new Map([[sha256Hex(v1), "pulled"]]) })).toBeNull()
  })

  test("channel 与 v1 双双拉取失败 → channel last-known-good 兜底(loud)", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    const seed = serve(channelRoutes(k, payload))
    expect((await refreshRemoteCatalog(dir, "stable", depsOf(seed.fetchImpl, k))).source).toBe("remote")
    const { fetchImpl: dead } = serve({})
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(dead, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.version).toBe("2026-07-13.1")
    expect(r.error ?? "").not.toBe("")
  })
})

// ── REQ-098 #302:环境通道路由(冻结 registryChannel → catalog 拉取)──────────────────────────

describe("#302 环境通道路由", () => {
  test("三环境映射驱动拉取 URL:prod→stable / beta→preview / dev→dev(全链验签过)", async () => {
    for (const [env, channel] of [["prod", "stable"], ["beta", "preview"], ["dev", "dev"]] as const) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `rc-route-${channel}-`))
      const k = genKey()
      const payload = payloadOf("2026-07-13.1", channel)
      const { fetchImpl, calls } = serve(channelRoutes(k, payload, {}, channel))
      const r = await refreshRemoteCatalog(d, registryChannelFor(env), depsOf(fetchImpl, k))
      expect(r.source).toBe("remote")
      if (r.source === "none") throw new Error("unreachable")
      expect(r.via).toBe(`channel-${channel}`)
      expect(r.channel).toBe(channel)
      expect(calls.some((u) => u.endsWith(`/channels/${channel}.json`))).toBe(true)
      expect(calls.some((u) => u === V1_URL)).toBe(false)
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  test("非 stable 通道失败绝不访问 v1(fail closed):无 LKG → none,V1 URL 零请求", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.9", "legacy")
    // 只有 v1 端点可用;preview 通道全 404。
    const { fetchImpl, calls } = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "preview", depsOf(fetchImpl, k))
    expect(r.source).toBe("none")
    expect(calls.some((u) => u === V1_URL || u === `${V1_URL}.sig`)).toBe(false)
  })

  test("非 stable 通道失败退同通道 LKG(已验缓存),仍不打 v1", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1", "pv")
    const good = serve(channelRoutes(k, payload, {}, "preview"))
    expect((await refreshRemoteCatalog(dir, "preview", depsOf(good.fetchImpl, k))).source).toBe("remote")
    const v1 = payloadOf("2026-07-13.9", "legacy")
    const bad = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "preview", depsOf(bad.fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.channel).toBe("preview")
    expect(r.version).toBe("2026-07-13.1") // preview LKG,不是 stable v1 的 2026-07-13.9
    expect(bad.calls.some((u) => u === V1_URL || u === `${V1_URL}.sig`)).toBe(false)
  })

  test("singleflight:同 (dir, channel) 并发合并为一次拉取,结果一致", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    const { fetchImpl, calls } = serve(channelRoutes(k, payload))
    const deps = depsOf(fetchImpl, k)
    const [a, b] = await Promise.all([refreshRemoteCatalog(dir, "stable", deps), refreshRemoteCatalog(dir, "stable", deps)])
    expect(a.source).toBe("remote")
    expect(b.source).toBe("remote")
    if (a.source === "none" || b.source === "none") throw new Error("unreachable")
    expect(a.version).toBe(b.version)
    expect(calls.filter((u) => u.endsWith("/channels/trust.json")).length).toBe(1)
  })
})
