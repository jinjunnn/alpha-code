// REQ-101 #315 —— advisory 激活闸:匹配语义(向量钉住)+ 新鲜度 + 生产链 wiring
// (真实 refreshChannelCatalog 落盘 → makeAdvisoryGate 真信任链 → planner 真函数)。
//
// 匹配语义(B 侧 vectors.json `_matching` 条目 = 合同):catalogId 精确授权;digest-scoped
// 只拦对应域 digest;withdrawn 永不拦;name 不授权;多命中任一 active 即拦。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { evaluateAdvisoryGate, makeAdvisoryGate } from "./ext-advisory-gate"
import { setInstallStateByKey } from "./ext-install-planner"
import { validateAdvisoriesDoc, type AdvisoriesDoc } from "./catalog-channels"
import { refreshChannelCatalog } from "./catalog-channels"
import { upsertRecordV2 } from "./ext-receipt-v2"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const VEC_DIR = path.join(import.meta.dir, "testvectors", "catalog-channels")
const vecStr = (f: string) => fs.readFileSync(path.join(VEC_DIR, f), "utf8")

const vectorAdvisories = (() => {
  const v = validateAdvisoriesDoc(JSON.parse(vecStr("advisories.json")))
  if (!v.ok) throw new Error(v.error)
  return v.doc
})()

const fresh = (doc: AdvisoriesDoc) => ({ doc, stale: false })

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisory-gate-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("#315 匹配语义(B 侧向量 = 合同)", () => {
  const view = fresh(vectorAdvisories)

  test("active advisory 按 catalogId 精确拦;其它 id 不受影响", () => {
    const hit = evaluateAdvisoryGate(view, { catalogId: "skill:vector-demo", provenance: "cache" })
    expect(hit.allowed).toBe(false)
    if (hit.allowed) throw new Error("unreachable")
    expect(hit.advisoryId).toBe("adv-vector-active")
    // 前缀/相似 id 不命中(精确相等)
    expect(evaluateAdvisoryGate(view, { catalogId: "skill:vector-demo2", provenance: "cache" }).allowed).toBe(true)
  })

  test("withdrawn 永不拦(rationale 仅留档)", () => {
    expect(evaluateAdvisoryGate(view, { catalogId: "mcp:vector-mcp", provenance: "cache" }).allowed).toBe(true)
  })

  test("digest-scoped:仅对应 aggregate-files digest 被拦;其它版本放行;缺 digest 上下文保守拦", () => {
    // 向量里 skill:vector-demo 同时有全面 active(adv-vector-active)——为隔离 digest 语义,构造只含 digest-scoped 记录的视图
    const digestRec = vectorAdvisories.records.find((r) => r.advisoryId === "adv-vector-digest-scoped")!
    const view2 = fresh({ ...vectorAdvisories, records: [digestRec] })
    const flagged = "a".repeat(64)
    const blocked = evaluateAdvisoryGate(view2, { catalogId: "skill:vector-demo", payloadDigest: flagged, provenance: "cache" })
    expect(blocked.allowed).toBe(false)
    if (blocked.allowed) throw new Error("unreachable")
    expect(blocked.advisoryId).toBe("adv-vector-digest-scoped")
    // 不同 payloadDigest(其它版本)→ 放行
    expect(evaluateAdvisoryGate(view2, { catalogId: "skill:vector-demo", payloadDigest: "b".repeat(64), provenance: "cache" }).allowed).toBe(true)
    // 上下文缺 aggregate digest → 无法自证非被公示内容 → 保守拦
    expect(evaluateAdvisoryGate(view2, { catalogId: "skill:vector-demo", provenance: "cache" }).allowed).toBe(false)
  })

  test("name 不授权:同名不同 id 不拦;不同名同 id 照拦", () => {
    expect(evaluateAdvisoryGate(view, { catalogId: "skill:other", name: "vector demo skill", provenance: "cache" }).allowed).toBe(true)
    expect(evaluateAdvisoryGate(view, { catalogId: "skill:vector-demo", name: "renamed", provenance: "cache" }).allowed).toBe(false)
  })

  test("多记录命中任一 active 即拦", () => {
    const both = fresh({
      ...vectorAdvisories,
      records: [
        { ...vectorAdvisories.records[1] }, // withdrawn(同 catalogId 不同记录也可,但这里用原样)
        { ...vectorAdvisories.records[0], catalogId: "mcp:vector-mcp" }, // active 指向同一 id
      ],
    })
    expect(evaluateAdvisoryGate(both, { catalogId: "mcp:vector-mcp", provenance: "cache" }).allowed).toBe(false)
  })
})

describe("#315 新鲜度与来源(绝不退空集)", () => {
  test("remote/cache 来源:无可验公示(冷启动)→ 拦;bundled/seed → 静态基线放行", () => {
    const cold = evaluateAdvisoryGate(null, { catalogId: "skill:anything", provenance: "remote" })
    expect(cold.allowed).toBe(false)
    if (cold.allowed) throw new Error("unreachable")
    expect(cold.advisoryId).toBe("advisories-unavailable")
    expect(evaluateAdvisoryGate(null, { catalogId: "skill:anything", provenance: "seed" }).allowed).toBe(true)
    expect(evaluateAdvisoryGate(null, { catalogId: "skill:anything", provenance: "bundled" }).allowed).toBe(true)
  })

  test("stale(过 expires = 最大 stale 窗口):remote/cache 拦;seed 仍可用且 stale 命中照拦", () => {
    const stale = { doc: vectorAdvisories, stale: true }
    const r = evaluateAdvisoryGate(stale, { catalogId: "skill:unrelated", provenance: "cache" })
    expect(r.allowed).toBe(false)
    if (r.allowed) throw new Error("unreachable")
    expect(r.advisoryId).toBe("advisories-stale")
    expect(evaluateAdvisoryGate(stale, { catalogId: "skill:unrelated", provenance: "seed" }).allowed).toBe(true)
    expect(evaluateAdvisoryGate(stale, { catalogId: "skill:vector-demo", provenance: "seed" }).allowed).toBe(false) // stale 命中照拦
  })

  test("office 静态基线(随包)对一切来源生效", () => {
    const office = evaluateAdvisoryGate(null, { catalogId: "mcp:excel", provenance: "seed" })
    // ARCHIVED_OFFICE_ADVISORIES 若含 excel 类条目则拦;至少断言机制在(以真实表首条为准)
    void office
    const { ARCHIVED_OFFICE_ADVISORIES } = require("../shared/office-advisories") as typeof import("../shared/office-advisories")
    if (ARCHIVED_OFFICE_ADVISORIES.length > 0) {
      const first = ARCHIVED_OFFICE_ADVISORIES[0]!
      const hit = evaluateAdvisoryGate(null, { catalogId: first.catalogId, provenance: "seed" })
      expect(hit.allowed).toBe(false)
      if (hit.allowed) throw new Error("unreachable")
      expect(hit.advisoryId).toBe(`office:${first.catalogId}`)
    }
  })
})

describe("#315 生产链 wiring:refresh 落盘 → makeAdvisoryGate 真信任链 → planner 真函数", () => {
  type TestKey = { keyId: string; publicKeyB64: string; privateKey: crypto.KeyObject }
  function genKey(): TestKey {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    const der = publicKey.export({ type: "spki", format: "der" }) as Buffer
    return { keyId: crypto.createHash("sha256").update(der).digest("hex"), publicKeyB64: der.toString("base64"), privateKey }
  }
  const signB64 = (body: string, key: TestKey) => crypto.sign(null, Buffer.from(body, "utf8"), key.privateKey).toString("base64")
  const BASE = "https://wiring.test/catalog/v1"
  const sha256Hex = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex")

  test("远端公示的 active advisory 经真实验证链落盘后,disabled→enabled 被真 planner 拒", async () => {
    const k = genKey()
    const doc = (o: Record<string, unknown>) => JSON.stringify(o, null, 2)
    const trust = doc({
      schema: "alpha.catalog.trust.v1",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-12-31T00:00:00.000Z",
      keyId: k.keyId,
      keys: [{ keyId: k.keyId, publicKey: k.publicKeyB64, status: "active", notBefore: "2026-01-01T00:00:00.000Z" }],
      revokedTargets: [],
    })
    const advisories = doc({
      schema: "alpha.catalog.advisories.v1",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-12-31T00:00:00.000Z",
      keyId: k.keyId,
      records: [
        { advisoryId: "adv-wire-1", catalogId: "skill:demo", reason: "wiring test advisory", publishedAt: "2026-07-13T00:00:00.000Z", status: "active" },
      ],
    })
    const payload = doc({ version: "2.0.0", entries: [{ id: "skill:demo" }] })
    const stable = doc({
      schema: "alpha.catalog.channel-metadata.v1",
      channel: "stable",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-08-12T00:00:00.000Z",
      keyId: k.keyId,
      target: {
        catalogVersion: "2.0.0",
        sha256: sha256Hex(payload),
        bytes: Buffer.byteLength(payload),
        url: `${BASE}/releases/2.0.0/catalog.json`,
        sigUrl: `${BASE}/releases/2.0.0/catalog.json.sig`,
      },
    })
    const entryOf = (b: string) => ({ sequence: (JSON.parse(b) as { sequence: number }).sequence, sha256: sha256Hex(b) })
    const snapshot = doc({
      schema: "alpha.catalog.snapshot.v1",
      sequence: 1,
      publishedAt: "2026-07-13T00:00:00.000Z",
      expires: "2026-08-12T00:00:00.000Z",
      keyId: k.keyId,
      entries: { trust: entryOf(trust), stable: entryOf(stable), advisories: entryOf(advisories) },
    })
    const routes: Record<string, string> = {
      [`${BASE}/channels/trust.json`]: trust,
      [`${BASE}/channels/trust.json.sig`]: signB64(trust, k),
      [`${BASE}/channels/advisories.json`]: advisories,
      [`${BASE}/channels/advisories.json.sig`]: signB64(advisories, k),
      [`${BASE}/channels/snapshot.json`]: snapshot,
      [`${BASE}/channels/snapshot.json.sig`]: signB64(snapshot, k),
      [`${BASE}/channels/stable.json`]: stable,
      [`${BASE}/channels/stable.json.sig`]: signB64(stable, k),
      [`${BASE}/releases/2.0.0/catalog.json`]: payload,
      [`${BASE}/releases/2.0.0/catalog.json.sig`]: signB64(payload, k),
    }
    const fetchImpl = (async (input: string | URL | Request) => {
      const hit = routes[String(input)]
      return hit === undefined ? new Response("nf", { status: 404 }) : new Response(hit)
    }) as typeof fetch

    // ① 真实验证链拉取并落盘(trust/snapshot/advisories/channel 全过)
    const r = await refreshChannelCatalog(dir, "stable", { fetchImpl, now: () => NOW, baseUrl: BASE, builtinKeyB64: k.publicKeyB64 })
    expect(r.source).toBe("remote")

    // ② 账本里放一条 disabled 的 catalog 来源 v2 record(全局 scope)
    const globalRoot = path.join(dir, "alpha-root")
    fs.mkdirSync(globalRoot, { recursive: true })
    const up = upsertRecordV2(globalRoot, {
      id: "skill:demo",
      name: "demo",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "disabled",
      origin: "catalog",
      installedAt: "2026-07-13T00:00:00.000Z",
    })
    expect(up.ok).toBe(true)

    // ③ 真 gate(makeAdvisoryGate 读真实 state,真信任链)+ 真 planner:enable 被拒
    const gate = makeAdvisoryGate(dir, { now: () => NOW, builtinKeyB64: k.publicKeyB64 })
    const refused = await setInstallStateByKey(
      { type: "skill", name: "demo", scope: "global", state: "enabled" },
      { globalRoot: () => globalRoot, advisoryGate: gate },
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error("unreachable")
    expect(refused.reason).toContain("adv-wire-1")
    // disable 不受闸(advisory 拦的是再启用)
    const disable = await setInstallStateByKey(
      { type: "skill", name: "demo", scope: "global", state: "disabled" },
      { globalRoot: () => globalRoot, advisoryGate: gate },
    )
    expect(disable.ok).toBe(true)
  })
})

describe("#315 review B1:懒冻结顺序(刷新后首次取用;冻结后不再变)", () => {
  test("先 refresh 落盘新公示 → 首次调用 gate 生效;冻结后清空 state 也不影响本操作视图", async () => {
    const k = (() => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
      const der = publicKey.export({ type: "spki", format: "der" }) as Buffer
      return { keyId: crypto.createHash("sha256").update(der).digest("hex"), publicKeyB64: der.toString("base64"), privateKey }
    })()
    const signB64 = (body: string) => crypto.sign(null, Buffer.from(body, "utf8"), k.privateKey).toString("base64")
    const BASE = "https://lazy.test/catalog/v1"
    const sha = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex")
    const doc = (o: Record<string, unknown>) => JSON.stringify(o, null, 2)
    const trust = doc({ schema: "alpha.catalog.trust.v1", sequence: 1, publishedAt: "2026-07-13T00:00:00.000Z", expires: "2026-12-31T00:00:00.000Z", keyId: k.keyId, keys: [{ keyId: k.keyId, publicKey: k.publicKeyB64, status: "active", notBefore: "2026-01-01T00:00:00.000Z" }], revokedTargets: [] })
    const advisories = doc({ schema: "alpha.catalog.advisories.v1", sequence: 1, publishedAt: "2026-07-13T00:00:00.000Z", expires: "2026-12-31T00:00:00.000Z", keyId: k.keyId, records: [{ advisoryId: "adv-lazy-1", catalogId: "skill:lazy", reason: "x", publishedAt: "2026-07-13T00:00:00.000Z", status: "active" }] })
    const payload = doc({ version: "1.0.0", entries: [{ id: "skill:lazy" }] })
    const stable = doc({ schema: "alpha.catalog.channel-metadata.v1", channel: "stable", sequence: 1, publishedAt: "2026-07-13T00:00:00.000Z", expires: "2026-08-12T00:00:00.000Z", keyId: k.keyId, target: { catalogVersion: "1.0.0", sha256: sha(payload), bytes: Buffer.byteLength(payload), url: `${BASE}/releases/1.0.0/catalog.json`, sigUrl: `${BASE}/releases/1.0.0/catalog.json.sig` } })
    const entryOf = (b: string) => ({ sequence: (JSON.parse(b) as { sequence: number }).sequence, sha256: sha(b) })
    const snapshot = doc({ schema: "alpha.catalog.snapshot.v1", sequence: 1, publishedAt: "2026-07-13T00:00:00.000Z", expires: "2026-08-12T00:00:00.000Z", keyId: k.keyId, entries: { trust: entryOf(trust), stable: entryOf(stable), advisories: entryOf(advisories) } })
    const routes: Record<string, string> = {
      [`${BASE}/channels/trust.json`]: trust, [`${BASE}/channels/trust.json.sig`]: signB64(trust),
      [`${BASE}/channels/advisories.json`]: advisories, [`${BASE}/channels/advisories.json.sig`]: signB64(advisories),
      [`${BASE}/channels/snapshot.json`]: snapshot, [`${BASE}/channels/snapshot.json.sig`]: signB64(snapshot),
      [`${BASE}/channels/stable.json`]: stable, [`${BASE}/channels/stable.json.sig`]: signB64(stable),
      [`${BASE}/releases/1.0.0/catalog.json`]: payload, [`${BASE}/releases/1.0.0/catalog.json.sig`]: signB64(payload),
    }
    const fetchImpl = (async (u: string | URL | Request) => (routes[String(u)] === undefined ? new Response("nf", { status: 404 }) : new Response(routes[String(u)]))) as typeof fetch

    // 复刻 ext-ipc 懒冻结:memo 首次取用在 refresh 之后
    let memo: ReturnType<typeof makeAdvisoryGate> | null = null
    const lazy: ReturnType<typeof makeAdvisoryGate> = (i) => (memo ??= makeAdvisoryGate(dir, { now: () => NOW, builtinKeyB64: k.publicKeyB64 }))(i)
    // 操作内先 refresh(会把新公示落盘)
    const r = await refreshChannelCatalog(dir, "stable", { fetchImpl, now: () => NOW, baseUrl: BASE, builtinKeyB64: k.publicKeyB64 })
    expect(r.source).toBe("remote")
    // 首次调用:看到刷新后的公示 → 拦
    expect(lazy({ catalogId: "skill:lazy", provenance: "remote" }).allowed).toBe(false)
    // 冻结后清空 state:本操作视图不变(仍拦)
    fs.rmSync(path.join(dir, "catalog-channel-state.json"))
    expect(lazy({ catalogId: "skill:lazy", provenance: "remote" }).allowed).toBe(false)
  })
})

describe("#315 review M3:非规范 catalog id 保守拦(catalog 面来源)", () => {
  test("大写/未归一 id 在 remote/cache/seed 拦;bundled(created/imported 面)不适用", () => {
    const r = evaluateAdvisoryGate(fresh(vectorAdvisories), { catalogId: "skill:Demo", provenance: "cache" })
    expect(r.allowed).toBe(false)
    if (r.allowed) throw new Error("unreachable")
    expect(r.advisoryId).toBe("advisory-uncanonical-id")
    expect(evaluateAdvisoryGate(fresh(vectorAdvisories), { catalogId: "user:my-thing", provenance: "bundled" }).allowed).toBe(true)
  })
})
