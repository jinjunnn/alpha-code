// REQ-101 A 侧接线测试 —— refreshRemoteCatalog 的 channel-first + #314 fail-closed 语义。
//
// 断言面:① channel(stable)全链路过 → 走 channel;② **security 失败绝不碰 v1**(零 V1 请求),
// LKG 或如实 none;③ availability 失败时 v1 仅可作**已验证 stable 身份的字节级镜像**(精确相等,
// 否则弃用);无已验证身份(fresh install)禁 v1;④ snapshot 缺失(404)= security;⑤ R11 对
// v1 缓存生效;⑥ 非 stable 通道恒不碰 v1;⑦ singleflight。纪律:无 mock.module,DI 全注入。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { sha256Hex, type ChannelClientDeps } from "./catalog-channels"
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

let advSeq = 200
function advisoriesBody(signer: TestKey, records: Record<string, unknown>[] = [], over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: "alpha.catalog.advisories.v1",
      sequence: ++advSeq,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-12-31T00:00:00.000Z",
      keyId: signer.keyId,
      records,
      ...over,
    },
    null,
    2,
  )
}

let snapSeq = 100 // 单调:等序异字节 = R5 replacement
function snapshotBody(signer: TestKey, members: Record<string, string>, over: Record<string, unknown> = {}): string {
  const entries: Record<string, { sequence: number; sha256: string }> = {}
  for (const [name, body] of Object.entries(members)) {
    entries[name] = { sequence: (JSON.parse(body) as { sequence: number }).sequence, sha256: sha256Hex(body) }
  }
  return JSON.stringify(
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
}

const payloadOf = (version: string, marker = "m") =>
  JSON.stringify({ version, entries: [{ id: `skill:${marker}` }] }, null, 2)

type Route = string | ((headers: Record<string, string>) => Response)
type RouteOpts = {
  channel?: string
  trustOver?: Record<string, unknown>
  docOver?: Record<string, unknown>
  /** 不 serve payload 路由 → 404 = security(被钉资源缺失)。 */
  omitPayload?: boolean
  /** payload 路由回 5xx → availability(纯服务故障)。 */
  failPayload500?: boolean
  /** 不 serve snapshot 路由(#314:缺失 = security)。 */
  omitSnapshot?: boolean
  /** advisory 记录(#315)。 */
  advisoryRecords?: Record<string, unknown>[]
}
function channelRoutes(k: TestKey, payloadBody: string, opts: RouteOpts = {}): Record<string, Route> {
  const channel = opts.channel ?? "stable"
  const trust = trustBody(k, opts.trustOver)
  const doc = channelBody(k, payloadBody, { channel, ...opts.docOver })
  const adv = advisoriesBody(k, opts.advisoryRecords ?? [])
  const snap = snapshotBody(k, { trust, [channel]: doc, advisories: adv })
  const version = (JSON.parse(payloadBody) as { version: string }).version
  const routes: Record<string, Route> = {
    [`${CH_BASE}/channels/trust.json`]: trust,
    [`${CH_BASE}/channels/trust.json.sig`]: signB64(trust, k),
    [`${CH_BASE}/channels/advisories.json`]: adv,
    [`${CH_BASE}/channels/advisories.json.sig`]: signB64(adv, k),
    [`${CH_BASE}/channels/${channel}.json`]: doc,
    [`${CH_BASE}/channels/${channel}.json.sig`]: signB64(doc, k),
  }
  if (!opts.omitSnapshot) {
    routes[`${CH_BASE}/channels/snapshot.json`] = snap
    routes[`${CH_BASE}/channels/snapshot.json.sig`] = signB64(snap, k)
  }
  if (opts.failPayload500) {
    routes[`${CH_BASE}/releases/${version}/catalog.json`] = () => new Response("boom", { status: 503 })
    routes[`${CH_BASE}/releases/${version}/catalog.json.sig`] = () => new Response("boom", { status: 503 })
  } else if (!opts.omitPayload) {
    routes[`${CH_BASE}/releases/${version}/catalog.json`] = payloadBody
    routes[`${CH_BASE}/releases/${version}/catalog.json.sig`] = signB64(payloadBody, k)
  }
  return routes
}

const depsOf = (fetchImpl: typeof fetch, k: TestKey): ChannelClientDeps => ({
  fetchImpl,
  now: () => NOW,
  baseUrl: CH_BASE,
  builtinKeyB64: k.publicKeyB64,
})

const v1Hit = (calls: string[]) => calls.some((u) => u === V1_URL || u === `${V1_URL}.sig`)

/** 先经 channel 面建立健康 LKG(version 2026-07-13.1)。 */
async function seedStableLkg(k: TestKey, payload: string) {
  const seed = serve(channelRoutes(k, payload))
  const r = await refreshRemoteCatalog(dir, "stable", depsOf(seed.fetchImpl, k))
  expect(r.source).toBe("remote")
}

describe("refreshRemoteCatalog 接线(channel-first + #314 fail-closed before v1)", () => {
  test("channel(stable)全链路过 → via=channel-stable,采信已验 payload", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    const { fetchImpl, calls } = serve(channelRoutes(k, payload))
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.version).toBe("2026-07-13.1")
    expect(v1Hit(calls)).toBe(false)
  })

  test("fresh install + channel 面全 404 + 合法 v1 在线 → none(security),v1 零请求", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.1", "legacy")
    const { fetchImpl, calls } = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.reasonClass).toBe("security") // 无可验 trust
    expect(v1Hit(calls)).toBe(false)
  })

  test("security 失败(channel doc 被篡改)+ 合法 v1 在线 → 绝不碰 v1,LKG 兜底", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    // 第二世界:doc 字节被改(签名失效),v1 完全合法可用
    const routes = channelRoutes(k, payload)
    const tampered = routes[`${CH_BASE}/channels/stable.json`].replace('"sequence": 5', '"sequence": 6')
    routes[`${CH_BASE}/channels/stable.json`] = tampered
    // snapshot 重钉篡改后的字节(攻击者可自建 snapshot?不能 —— 无签名钥;这里保持旧 snapshot = R13/R1 双杀)
    const v1 = payloadOf("2026-07-13.1", "legacy")
    routes[V1_URL] = v1
    routes[`${V1_URL}.sig`] = signB64(v1, k)
    const { fetchImpl, calls } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.reasonClass).toBe("security")
    expect(v1Hit(calls)).toBe(false)
  })

  test("snapshot 缺失(404)= security:LKG 兜底,v1 零请求", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    const routes = channelRoutes(k, payload, { omitSnapshot: true })
    const v1 = payloadOf("2026-07-13.1", "legacy")
    routes[V1_URL] = v1
    routes[`${V1_URL}.sig`] = signB64(v1, k)
    const { fetchImpl, calls } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.error ?? "").toContain("R13")
    expect(r.reasonClass).toBe("security")
    expect(v1Hit(calls)).toBe(false)
  })

  test("availability(payload 拉取失败)+ 已验身份 + v1 同身份 → v1 作字节级镜像(via=v1)", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    // availability 注入 = 新版本 payload 路由回 5xx(纯服务故障;404 属 security,另有用例)。
    const payload2 = payloadOf("2026-07-13.2")
    const routes = channelRoutes(k, payload2, { docOver: { sequence: 6 }, failPayload500: true })
    // v1 = LKG 身份(version 2026-07-13.1 的同一字节)→ 镜像放行
    routes[V1_URL] = payload
    routes[`${V1_URL}.sig`] = signB64(payload, k)
    const { fetchImpl } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("v1")
    expect(r.version).toBe("2026-07-13.1") // 镜像 = 已验证身份,不是 v1 自称的任何新内容
  })

  test("availability + v1 身份不符(更新版本)→ 拒 v1,LKG 兜底(via=channel-stable)", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    const payload2 = payloadOf("2026-07-13.2")
    const routes = channelRoutes(k, payload2, { docOver: { sequence: 6 }, failPayload500: true })
    const v1Newer = payloadOf("2026-07-13.9", "newer") // 合法签名但身份 ≠ 已验证 stable
    routes[V1_URL] = v1Newer
    routes[`${V1_URL}.sig`] = signB64(v1Newer, k)
    const { fetchImpl } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.version).toBe("2026-07-13.1")
  })

  test("availability + v1 验签不过 → 拒 v1,LKG 兜底", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    const payload2 = payloadOf("2026-07-13.2")
    const routes = channelRoutes(k, payload2, { docOver: { sequence: 6 }, failPayload500: true })
    routes[V1_URL] = payload
    routes[`${V1_URL}.sig`] = signB64("tampered bytes", k)
    const { fetchImpl } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
  })

  test("payload 404(被钉资源缺失)= security:零 v1 请求,LKG 兜底", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    const payload2 = payloadOf("2026-07-13.2")
    const routes = channelRoutes(k, payload2, { docOver: { sequence: 6 }, omitPayload: true })
    const v1 = payloadOf("2026-07-13.1", "legacy")
    routes[V1_URL] = v1
    routes[`${V1_URL}.sig`] = signB64(v1, k)
    const { fetchImpl, calls } = serve(routes)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.reasonClass).toBe("security")
    expect(v1Hit(calls)).toBe(false)
  })

  test("availability + v1 网络失败 → v1 缓存作身份镜像(同一已验 body;cache 带 reasonClass)", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    // 先经一次 availability 镜像把 v1 缓存落盘
    const payload2 = payloadOf("2026-07-13.2")
    const routes1 = channelRoutes(k, payload2, { docOver: { sequence: 6 }, failPayload500: true })
    routes1[V1_URL] = payload
    routes1[`${V1_URL}.sig`] = signB64(payload, k)
    expect((await refreshRemoteCatalog(dir, "stable", depsOf(serve(routes1).fetchImpl, k))).source).toBe("remote")
    // 第二轮:payload 仍 5xx,v1 远端也 5xx → v1 缓存(身份匹配)兜底
    const routes2 = channelRoutes(k, payload2, { docOver: { sequence: 7 }, failPayload500: true })
    routes2[V1_URL] = () => new Response("boom", { status: 503 })
    routes2[`${V1_URL}.sig`] = () => new Response("boom", { status: 503 })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(serve(routes2).fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("v1")
    expect(r.version).toBe("2026-07-13.1")
    expect(r.reasonClass).toBe("availability")
  })

  test("availability + v1 304 → 缓存身份镜像(同一已验 body)", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    const payload2 = payloadOf("2026-07-13.2")
    const routes1 = channelRoutes(k, payload2, { docOver: { sequence: 6 }, failPayload500: true })
    routes1[V1_URL] = (headers) => new Response(payload, { headers: { etag: '"e1"' } })
    routes1[`${V1_URL}.sig`] = signB64(payload, k)
    expect((await refreshRemoteCatalog(dir, "stable", depsOf(serve(routes1).fetchImpl, k))).source).toBe("remote")
    const routes2 = channelRoutes(k, payload2, { docOver: { sequence: 7 }, failPayload500: true })
    routes2[V1_URL] = (headers) =>
      headers["if-none-match"] === '"e1"' ? new Response(null, { status: 304 }) : new Response(payload, { headers: { etag: '"e1"' } })
    routes2[`${V1_URL}.sig`] = signB64(payload, k)
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(serve(routes2).fetchImpl, k))
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("v1")
    expect(r.version).toBe("2026-07-13.1")
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

  test("channel 全断(availability)→ channel last-known-good 兜底(loud),身份未知不碰 v1", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1")
    await seedStableLkg(k, payload)
    // 全 404:trust 走缓存,snapshot 404 = security → LKG;v1 不碰
    const v1 = payloadOf("2026-07-13.9", "legacy")
    const { fetchImpl, calls } = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "stable", depsOf(fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.via).toBe("channel-stable")
    expect(r.version).toBe("2026-07-13.1")
    expect(r.error ?? "").not.toBe("")
    expect(v1Hit(calls)).toBe(false)
  })
})

// ── REQ-098 #302:环境通道路由(冻结 registryChannel → catalog 拉取)──────────────────────────

describe("#302 环境通道路由", () => {
  test("三环境映射驱动拉取 URL:prod→stable / beta→preview / dev→dev(全链验签过)", async () => {
    for (const [env, channel] of [["prod", "stable"], ["beta", "preview"], ["dev", "dev"]] as const) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `rc-route-${channel}-`))
      const k = genKey()
      const payload = payloadOf("2026-07-13.1", channel)
      const { fetchImpl, calls } = serve(channelRoutes(k, payload, { channel }))
      const r = await refreshRemoteCatalog(d, registryChannelFor(env), depsOf(fetchImpl, k))
      expect(r.source).toBe("remote")
      if (r.source === "none") throw new Error("unreachable")
      expect(r.via).toBe(`channel-${channel}`)
      expect(r.channel).toBe(channel)
      expect(calls.some((u) => u.endsWith(`/channels/${channel}.json`))).toBe(true)
      expect(v1Hit(calls)).toBe(false)
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  test("非 stable 通道失败绝不访问 v1(fail closed):无 LKG → none,V1 URL 零请求", async () => {
    const k = genKey()
    const v1 = payloadOf("2026-07-13.9", "legacy")
    const { fetchImpl, calls } = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "preview", depsOf(fetchImpl, k))
    expect(r.source).toBe("none")
    if (r.source !== "none") throw new Error("unreachable")
    expect(r.reasonClass).toBe("security")
    expect(v1Hit(calls)).toBe(false)
  })

  test("非 stable 通道失败退同通道 LKG(已验缓存),仍不打 v1", async () => {
    const k = genKey()
    const payload = payloadOf("2026-07-13.1", "pv")
    const good = serve(channelRoutes(k, payload, { channel: "preview" }))
    expect((await refreshRemoteCatalog(dir, "preview", depsOf(good.fetchImpl, k))).source).toBe("remote")
    const v1 = payloadOf("2026-07-13.9", "legacy")
    const bad = serve({ [V1_URL]: v1, [`${V1_URL}.sig`]: signB64(v1, k) })
    const r = await refreshRemoteCatalog(dir, "preview", depsOf(bad.fetchImpl, k))
    expect(r.source).toBe("cache")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.channel).toBe("preview")
    expect(r.version).toBe("2026-07-13.1") // preview LKG,不是 stable v1 的 2026-07-13.9
    expect(v1Hit(bad.calls)).toBe(false)
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

  // REQ-128 #702 R1 审计 B1:package 消费必须挂在**生产**刷新链上。
  // 原 wiring 用例自己拼 refresh 闭包,`remote-catalog.ts:225` 那处真实接线删掉后全量仍全绿。
  // 本用例驱动的是真的 `refreshRemoteCatalog`,摘掉接线即红(已反向验证)。
  //
  // 已知冗余(留痕,非缺口):`refreshChannelCatalog` 的候选消费门与 `:225` 的最终评估
  // 对任何可构造输入都互为冗余 —— 摘掉任一条,另一条都会拦住同样的坏 package。
  // 因此候选门是纵深防御而非承重闸,不为它单造用例。
  test("REQ-128:真 refreshRemoteCatalog 会评估已签快照里的 package 并投影 safe view", async () => {
    const artifactDir = path.resolve(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package")
    const compiled = (await Bun.file(path.resolve(artifactDir, "expected.mcp-remote.compiled.json")).json()) as {
      envelope: Record<string, any>
      payload: Record<string, any>
    }
    const envelope = structuredClone(compiled.envelope)
    const payload = structuredClone(compiled.payload)
    // 语料那份 compiled 示例声明了 requiredSecrets 却给空 headersTemplate,宿主判
    // package-prerequisite-invalid。此处补消费占位符,使本用例测的是「生产链有没有评估」。
    // 那份夹具本身的自洽性问题属 producer 侧,已单独留痕。
    payload.behavior.headersTemplate = { Authorization: "Bearer {A_KEY}", "X-Token": "{B_TOKEN}" }
    const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
    envelope.components[0].payloadRef.bytes = bytes.byteLength
    envelope.components[0].payloadRef.sha256 = crypto.createHash("sha256").update(bytes).digest("hex")

    const k = genKey()
    const body = JSON.stringify({ version: "2026-07-13.1", entries: [{ id: "skill:m" }], packages: [envelope] }, null, 2)
    const { fetchImpl } = serve(channelRoutes(k, body))
    const r = await refreshRemoteCatalog(dir, "stable", {
      ...depsOf(fetchImpl, k),
      packageInstallability: { fetchPayload: async () => bytes },
    })
    expect(r.source).toBe("remote")
    if (r.source === "none") throw new Error("unreachable")
    expect(r.packageViews?.map((v) => v.catalogId)).toEqual([envelope.prelude.packageId])
    expect(r.packageViews?.[0]?.verdict).toBe("compatible")
  })
})
