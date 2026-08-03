// REQ-128 Phase 4 `#808` —— 宿主取回资产这一跳的两道保护(基线 §5 第 2 类的「catalog → 宿主」行)。
//
// 本票只补两件事,判据也只钉这两件:
//   ① **超时**:服务端永不 EOF ⇒ admission 必须**有界失败**,不是挂死;
//   ② **终态 URL 复查**:`response.url` 非 HTTPS 或带 userinfo ⇒ 拒绝。
// 两条都与 payload 那条路(`package-installability.ts:37/539/543/546-550`)逐条对称 ——
// 本相位补的就是这条不对称。
//
// ── 夹具为什么是**两个 markdown 资产**、不碰任何 plugin 形状 ────────────────────────────
// 这道闸落在 `fetchPackageAsset` 一个函数上,**与载荷种类无关**:凡是内容寻址资产都走它。
// 所以夹具刻意只用 skill / agent 两种早已在生产里的载荷 —— `opencode-plugin` profile 正在被
// 回滚,拿它当夹具等于把一道通用闸绑在一个要消失的形状上。
//
// ── 为什么这个文件长这样(R1 审计 F10,假闸形态⑤/⑧)──────────────────────────────────────
// admission 取资产时优先用注入的 helper:`(deps.fetchAsset ?? fetchPackageAsset)(assetRef)`
// (`package-admission.ts:540`),而现有 package 测试**大量注入它**(`package-update.test.ts:177`
// 起五处、`package-admission.parity.test.ts:135`)。⇒ 在注入态下,把生产的 timeout 与 URL 复查
// **整段删掉,那些测试照样全绿** —— 它们测的是自己写的替身。
//
// 所以这里:**真 `createPackageAdmissionCoordinator`**、**不传 `deps.fetchAsset`**、
// **也不传 `deps.installability.fetchPayload`**,只替换 `globalThis.fetch`。两条取回都必须
// 落到生产下载器上。
//
// ── 每条断言都过一遍「一个错误实现能不能满足它?」────────────────────────────────────────
//   · 只断 `ok === false` 不行:admission 有几十条拒绝路径,一个**根本没下载**就拒掉的实现
//     也满足它。⇒ 每条负例都同时断言「那个资产 URL 真的被请求过」+「拒绝理由恰是资产完整性
//     那一条」+「**没有**走到授权屏」。
//   · 只断负例不行:一个「什么都拒」的实现全绿。⇒ 第一条用例是**正向控制**(不动任何东西 ⇒
//     必须走到授权屏),最后一条是**过宽控制**(终态 URL = 请求 URL 的干净 https ⇒ 仍须放行)。
//     后者不是凑数:真 fetch **总是**给 `response.url` 赋值,一个写成「`response.url` 有值就拒」
//     或「终态 ≠ 请求就拒」的闸会**拒载全部真实安装** —— 前提为假的闸门比没有闸门更贵。
//   · 超时那条不断「有没有传 signal」(那是形状不是行为):断的是**它真的中止了**
//     (`signal.aborted`)+ 整个调用**落地了**(否则本用例挂到显式超时判红)。

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createPackageAdmissionCoordinator } from "./package-admission"

/** 生产的拒绝措辞,**独立字面量**——不从被测模块 import,免得改错了两边一起自洽。 */
const ASSET_REFUSAL = "package admission: package asset unavailable or failed integrity"

const PACKAGE_ID = "package:asset-fetch-gate"
const ROOT_AGENT_ID = "agent:asset-fetch-root"
/** 两个 leaf 的 id 顺序是**有意的**:admission 按组件 id 排序取资产(`package-admission.ts:509-514`),
 *  所以 `alpha` 的资产先被请求、`beta` 的在它之后 —— 负例里 `beta` 必须**没被请求过**。 */
const LEAF_EARLY_ID = "skill:asset-alpha"
const LEAF_LATE_ID = "skill:asset-beta"

const ASSET_HOST = "https://alphacodeone.com/catalog/assets"
const ROOT_ASSET_URL = `${ASSET_HOST}/agent.asset-fetch-root/1.0.0/AGENT.md`
const EARLY_ASSET_URL = `${ASSET_HOST}/skill.asset-alpha/1.0.0/SKILL.md`
const LATE_ASSET_URL = `${ASSET_HOST}/skill.asset-beta/1.0.0/SKILL.md`

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const utf8 = (text: string) => new TextEncoder().encode(text)
const canonicalBytes = (value: unknown) => utf8(`${JSON.stringify(value, null, 2)}\n`)

const agentMd = (name: string) => `---
name: ${name}
description: REQ-128 #808 asset-fetch fixture
mode: subagent
---

Deterministic fixture body.
`

const skillMd = (name: string) => `---
name: ${name}
description: REQ-128 #808 asset-fetch fixture
---

Deterministic fixture body.
`

type Fixture = {
  envelope: unknown
  /** payloadRef.url → 字节(`fetchPackagePayload` 的服务器)。 */
  payloadByUrl: Map<string, Uint8Array>
  /** 资产 url → 字节(`fetchPackageAsset` 的服务器)。 */
  assetByUrl: Map<string, Uint8Array>
}

/**
 * root agent + 两个 skill leaf,每个都带一个 markdown 资产。三个资产是本文件的全部素材:
 * 一个在被做手脚的那个**之前**(证明闸不是「什么都拒」),一个在它**之后**(证明整包在那一条
 * 上就停了)。
 */
function fixtureOf(): Fixture {
  const assets = new Map<string, Uint8Array>([
    [ROOT_ASSET_URL, utf8(agentMd("asset-fetch-root"))],
    [EARLY_ASSET_URL, utf8(skillMd("asset-alpha"))],
    [LATE_ASSET_URL, utf8(skillMd("asset-beta"))],
  ])

  const payloadOf = (profileId: "agent" | "skill", url: string) => ({
    schema: `alpha.host-extension-package.payload.${profileId}.v1`,
    behavior: {
      targetDir: profileId === "agent" ? "alpha-agents" : "alpha-skills",
      asset: {
        sha256: sha(assets.get(url)!),
        bytes: assets.get(url)!.byteLength,
        mediaType: "text/markdown",
        url,
      },
    },
  })

  const payloadByUrl = new Map<string, Uint8Array>()
  const componentOf = (
    id: string,
    profileId: "agent" | "skill",
    assetUrl: string,
    dependencies: string[] = [],
  ) => {
    const bytes = canonicalBytes(payloadOf(profileId, assetUrl))
    const url = `${ASSET_HOST}/${id.replace(":", ".")}/1.0.0/alpha-package/payload.json`
    payloadByUrl.set(url, bytes)
    return {
      id,
      required: true,
      dependencies,
      profileId,
      profileVersion: 1,
      capabilities: [] as string[],
      payloadRef: {
        sha256: sha(bytes),
        bytes: bytes.byteLength,
        mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
        url,
      },
    }
  }

  const components = [
    componentOf(ROOT_AGENT_ID, "agent", ROOT_ASSET_URL, [LEAF_EARLY_ID, LEAF_LATE_ID]),
    componentOf(LEAF_EARLY_ID, "skill", EARLY_ASSET_URL),
    componentOf(LEAF_LATE_ID, "skill", LATE_ASSET_URL),
  ]

  return {
    envelope: {
      schema: "alpha.host-extension-package.v1",
      prelude: { packageId: PACKAGE_ID, version: "1.0.0" },
      root: ROOT_AGENT_ID,
      presentation: { displayName: "Asset fetch gate", description: "REQ-128 #808 fixture" },
      components,
      capabilities: [] as string[],
    },
    payloadByUrl,
    assetByUrl: assets,
  }
}

/** 这一次要对某个资产 URL 做的手脚。缺省(undefined)= 老老实实按夹具应答。 */
type AssetOverride =
  /** 永不 EOF 的服务端:连接开着、一个字节都不发。只有 abort 能让它落地。 */
  | { url: string; mode: "hang" }
  /** 应答**正确的字节**(签名复验会通过),但终态 URL 是给定的这个。 */
  | { url: string; mode: "final-url"; finalUrl: string }

let tmp = ""
let root = ""
let userData = ""
let fixture: Fixture
let override: AssetOverride | undefined
let fetchedUrls: string[] = []
/** 生产为**那个被做手脚的资产**这次请求所带的 signal(没带 = undefined)。 */
let hangSignal: AbortSignal | undefined
let transactionCalls = 0

const previousRoot = process.env.ALPHA_GLOBAL_DIR
const realFetch = globalThis.fetch

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  fetchedUrls.push(url)

  // payload 也走生产下载器(`fetchPackagePayload`)—— 这里只是那台服务器。
  const payload = fixture.payloadByUrl.get(url)
  if (payload) return new Response(payload, { status: 200 })

  const asset = fixture.assetByUrl.get(url)
  if (!asset) throw new Error(`unexpected fetch: ${url}`)
  if (!override || override.url !== url) return new Response(asset, { status: 200 })

  if (override.mode === "hang") {
    hangSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      // 生产没给期限 ⇒ 这个 promise **永不落地**,和真实的「服务端不发 EOF」一模一样:
      // admission 停在这里,用例挂到显式超时被判红。这正是本条要抓的东西。
      if (!signal) return
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")))
    })
  }

  const response = new Response(asset, { status: 200 })
  // 真 fetch 用终态地址填 `response.url`;合成 Response 默认是空串,所以这里显式写。
  Object.defineProperty(response, "url", { value: override.finalUrl })
  return response
}) as typeof fetch

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "req128-808-asset-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
  fixture = fixtureOf()
  override = undefined
  fetchedUrls = []
  hangSignal = undefined
  transactionCalls = 0
  globalThis.fetch = fakeFetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * 跑**真** admission 的第一段(取回 + 完整性 + 授权预览)。资产下载就发生在这一段里
 * (`resolvePreparedPackage` → 组件循环 → `fetchPackageAsset`),所以两个 mutation 都在这里现身。
 *
 * `deps` 里**没有** `fetchAsset`,也**没有** `installability` —— 这是本文件的全部要害。
 */
async function admitOnce(attemptId: string) {
  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [fixture.envelope] },
      snapshotDigest: "5".repeat(64),
    }),
    root: () => root,
    userDataPath: userData,
    environment: () => "dev",
    now: () => new Date("2026-08-03T00:00:00.000Z"),
    transaction: async () => {
      transactionCalls++
      return { ok: false, stage: "staging", reason: "asset-fetch gate: transaction intercepted" }
    },
  })
  return (await admit({
    catalogId: PACKAGE_ID,
    scope: { scope: "global" as const },
    attemptId,
  })) as { ok: boolean; stage?: string; reason?: string }
}

describe("REQ-128 #808 宿主资产取回:timeout 与终态 URL 复查(真 admission,只换 globalThis.fetch)", () => {
  // ── 正向控制:先证明这套夹具**本来就装得进去** ────────────────────────────────────────
  // 没有它,下面三条负例全部可以被「什么都拒」满足。
  test("不做任何手脚:三个资产都经生产下载器取回,整包走到授权屏", async () => {
    const outcome = await admitOnce("asset-control")
    expect(outcome).toMatchObject({ ok: false, stage: "authorize" })
    expect(fetchedUrls).toContain(ROOT_ASSET_URL)
    expect(fetchedUrls).toContain(EARLY_ASSET_URL)
    expect(fetchedUrls).toContain(LATE_ASSET_URL)
    expect(transactionCalls).toBe(0)
  })

  // ── mutation ①:服务端永不 EOF ⇒ 有界失败 ────────────────────────────────────────────
  // 显式 30s:bun 默认 5s 会在生产 8s 期限**之前**就把用例杀掉 —— 那样量到的是「跑得太久」,
  // 不是「没有期限」,两者判据完全不同。删掉生产的 `setTimeout(... controller.abort())` ⇒
  // fetch 永不落地 ⇒ 本条挂到 30s 判红(实测记录见 PR)。
  test("mutation ①:资产服务端永不 EOF ⇒ admission 有界失败,不是挂死", async () => {
    override = { url: EARLY_ASSET_URL, mode: "hang" }
    const outcome = await admitOnce("asset-never-eof")

    expect(outcome).toMatchObject({ ok: false, reason: ASSET_REFUSAL })
    expect(outcome.stage).toBeUndefined()
    // 结束这次请求的是**我们自己的期限**,不是别的什么先一步拒了它。
    expect(hangSignal?.aborted).toBe(true)
    // 身份:挂住的确实是那个资产,而不是「整条链上任何一处先坏了」。
    expect(fetchedUrls).toContain(EARLY_ASSET_URL)
    // 同一道闸下,它**前面**那个资产正常取回了 ⇒ 不是「什么都拒」。
    expect(fetchedUrls).toContain(ROOT_ASSET_URL)
    // 组件循环在这一条上就返回了,后面的资产不再请求。
    expect(fetchedUrls).not.toContain(LATE_ASSET_URL)
    expect(transactionCalls).toBe(0)
  }, 30_000)

  // ── mutation ②:终态 URL ──────────────────────────────────────────────────────────────
  // 两条负例给的都是**字节完全正确**的应答(sha256/bytes 与签名逐字相符),所以删掉终态 URL
  // 复查之后它们会一路走到授权屏 ⇒ `stage === "authorize"` ⇒ 本条红。
  test("mutation ②a:终态 URL 带 userinfo ⇒ 整包拒绝,不进授权屏", async () => {
    override = {
      url: EARLY_ASSET_URL,
      mode: "final-url",
      finalUrl: EARLY_ASSET_URL.replace("https://", "https://harvester:s3cret@"),
    }
    const outcome = await admitOnce("asset-userinfo")

    expect(outcome).toMatchObject({ ok: false, reason: ASSET_REFUSAL })
    expect(outcome.stage).toBeUndefined()
    expect(fetchedUrls).toContain(EARLY_ASSET_URL)
    expect(fetchedUrls).toContain(ROOT_ASSET_URL)
    expect(fetchedUrls).not.toContain(LATE_ASSET_URL)
    expect(transactionCalls).toBe(0)
  })

  test("mutation ②b:终态 URL 非 HTTPS ⇒ 整包拒绝,不进授权屏", async () => {
    override = {
      url: EARLY_ASSET_URL,
      mode: "final-url",
      finalUrl: EARLY_ASSET_URL.replace("https://", "http://"),
    }
    const outcome = await admitOnce("asset-plain-http")

    expect(outcome).toMatchObject({ ok: false, reason: ASSET_REFUSAL })
    expect(outcome.stage).toBeUndefined()
    expect(fetchedUrls).toContain(EARLY_ASSET_URL)
    expect(fetchedUrls).toContain(ROOT_ASSET_URL)
    expect(fetchedUrls).not.toContain(LATE_ASSET_URL)
    expect(transactionCalls).toBe(0)
  })

  // ── 过宽控制:这一条防的是**我这次改动自己**变成一道拒载真实配置的闸 ────────────────────
  // 真 fetch 总会把请求地址写进 `response.url`。把复查写成「有值就拒」/「终态 ≠ 请求就拒」的
  // 实现,能满足上面两条负例,却会让**每一次真实安装**都失败。所以再钉一条:干净的 https
  // 终态 URL 必须原样放行。
  test("过宽控制:终态 URL = 请求 URL 的干净 https ⇒ 仍须放行(真 fetch 恒会填这个字段)", async () => {
    override = { url: EARLY_ASSET_URL, mode: "final-url", finalUrl: EARLY_ASSET_URL }
    const outcome = await admitOnce("asset-clean-final-url")

    expect(outcome).toMatchObject({ ok: false, stage: "authorize" })
    expect(fetchedUrls).toContain(EARLY_ASSET_URL)
    expect(fetchedUrls).toContain(LATE_ASSET_URL)
  })
})
