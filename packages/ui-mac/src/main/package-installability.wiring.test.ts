// REQ-128 production wiring gate. The repository's shipped Catalog currently has no packages[]
// instances, so the packages below are explicit host-owned constructions that reuse the pinned
// alpha-web corpus's identity. This is a reachability harness for the new path, not a claim that
// production traffic already exercises it.
//
// The one place the *actual* vendored producer bytes are read is the §5.1 transition gate at the
// bottom, which now asserts the re-vendored v2 artifact is accepted end to end (`#759`).

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import bundledCatalog from "../renderer/extensions/alpha-catalog.json"
import { CATALOG_PACKAGE_REASON_CODES, type CatalogPackageViewV1 } from "../shared/catalog-package-view"
import type { AlphaPackageEnvelopeV1, PackageProfilePayloadV1 } from "../shared/host-extension-package-contract/decoder"
import {
  evaluatePackageForHost,
  runCatalogInstallWithPackagePreflight,
  type PackageEvaluator,
} from "./package-installability"
import {
  evaluateRemoteCatalogPackages,
  PACKAGE_DETAIL_IPC_CHANNEL,
  registerPackageCatalogReadIpcHandlers,
  type RemoteCatalogResult,
} from "./remote-catalog"

const artifact = resolve(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package")

/**
 * The pinned producer output exactly as vendored — envelope and component payloads both.
 *
 * **Nothing here is patched.** The payload bytes are re-serialised from the corpus's own
 * `payloads` map and keyed by the digest the *signed envelope* declares, so a corpus whose
 * payload bytes do not reproduce its own `payloadRef` misses the lookup (or fails the host's
 * digest gate) and turns this file red instead of quietly passing. Adding a field to make the
 * envelope decode would be the false gate the §5.1 transition rule exists to prevent.
 */
const vendoredProducerPackage = async (file: string) => {
  const compiled = (await Bun.file(resolve(artifact, file)).json()) as {
    envelope: AlphaPackageEnvelopeV1
    payloads: Record<string, unknown>
    normalizedRecord: { root: { compatibility: { verdict: string } } }
  }
  const envelope = structuredClone(compiled.envelope)
  const payloadByDigest = new Map<string, Uint8Array>(
    envelope.components.map((component) => [
      component.payloadRef.sha256,
      new TextEncoder().encode(`${JSON.stringify(compiled.payloads[component.id], null, 2)}\n`),
    ]),
  )
  return { envelope, payloadByDigest, publishedVerdict: compiled.normalizedRecord.root.compatibility.verdict }
}

/**
 * A host-owned v2 package used to drive the production wiring. It reuses the producer corpus's
 * identity and presentation so the reachability claim stays comparable, but its shape is this
 * host's contract, not a claim about what the compiler emits today.
 */
const producerPackage = async () => {
  const payload = {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: "https://mcp.example.com/",
      headersTemplate: {
        Authorization: "Bearer {A_KEY}",
        "X-Token": "{B_TOKEN}",
      },
      requiredSecrets: ["A_KEY", "B_TOKEN"],
      auth: "none",
    },
  } as unknown as PackageProfilePayloadV1
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: "package:generic-remote-mcp", version: "1.0.0" },
    presentation: {
      displayName: "Generic Remote MCP",
      description: "Generic Phase 1 compiler corpus input.",
    },
    root: "mcp:generic-remote",
    components: [
      {
        id: "mcp:generic-remote",
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: ["alpha.secret-prerequisite.v1"],
        payloadRef: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.generic-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.secret-prerequisite.v1"],
  } as unknown as AlphaPackageEnvelopeV1
  return { envelope, bytes }
}

// 变参:detail 那条闸必须能分辨「按 id 查找」与「恒取第一个」——单条夹具下两者不可分辨。
const rawResult = (...envelopes: AlphaPackageEnvelopeV1[]): RemoteCatalogResult => ({
  source: "remote",
  catalog: { version: "2026-07-30", entries: [{}], packages: envelopes },
  version: "2026-07-30",
  fetchedAt: "2026-07-30T00:00:00.000Z",
  via: "channel-stable",
  channel: "stable",
})

type CapturedHandler = (event: unknown, ...args: unknown[]) => unknown

const registeredHandlers = (refresh: () => Promise<RemoteCatalogResult>) => {
  const handlers = new Map<string, CapturedHandler>()
  registerPackageCatalogReadIpcHandlers((channel, handler) => handlers.set(channel, handler), refresh)
  return handlers
}

describe("package installability production wiring", () => {
  test("refresh, browse, detail, and install preflight use the same evaluator reference", async () => {
    const { envelope, bytes } = await producerPackage()
    // 第二个 package:让 detail 的「按 id 查找」与「恒取 packageViews[0]」可分辨。
    const second = await producerPackage()
    second.envelope.prelude.packageId = "package:generic-remote-mcp-second"
    const raw = rawResult(envelope, second.envelope)
    const payloadFor = new Map<string, Uint8Array>([
      [envelope.prelude.packageId, bytes],
      [second.envelope.prelude.packageId, second.bytes],
    ])
    const calls: string[] = []
    const evaluator: PackageEvaluator = async (input, deps) => {
      calls.push("evaluatePackageForHost")
      const id = (input as AlphaPackageEnvelopeV1).prelude?.packageId
      return evaluatePackageForHost(input, {
        ...deps,
        fetchPayload: async () => payloadFor.get(id) ?? bytes,
      })
    }
    const refresh = () => evaluateRemoteCatalogPackages(raw, { packageEvaluator: evaluator })

    await refresh()
    const handlers = registeredHandlers(refresh)
    await handlers.get("ext-remote-catalog")!(undefined)
    // 取**第二个**:恒回 packageViews[0] 的实现会在这里被抓住。
    const detailSecond = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      second.envelope.prelude.packageId,
    )) as { catalogId?: string } | null
    expect(detailSecond?.catalogId).toBe(second.envelope.prelude.packageId)
    const canary = "REQ128_SECRET_CANARY_82ebda31"
    const preflight = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-1",
        grants: { secrets: { A_KEY: canary } },
      },
      {
        loadVerifiedCatalog: async () => ({
          source: "remote",
          catalog: raw.catalog,
        }),
        installLegacy: async () => ({ ok: true }),
        evaluator,
      },
    )

    // 2(refresh 评两个 package)+ 2(browse 再 refresh)+ 2(detail 再 refresh)+ 1(preflight 只评命中的那个)
    // = 7。四条入口若有任何一条改调独立副本,副本不会 push 进 calls,这里就短。
    expect(calls).toEqual(Array(7).fill("evaluatePackageForHost"))
    expect(preflight).toMatchObject({
      ok: false,
      package: {
        catalogId: "package:generic-remote-mcp",
        verdict: "compatible",
      },
    })
    expect(JSON.stringify(preflight)).not.toContain(canary)
  })

  test("actual registered IPC handlers return only the safe-view key whitelist", async () => {
    const { envelope, bytes } = await producerPackage()
    const refresh = () =>
      evaluateRemoteCatalogPackages(rawResult(envelope), {
        packageInstallability: { fetchPayload: async () => bytes },
      })
    const handlers = registeredHandlers(refresh)
    const browse = (await handlers.get("ext-remote-catalog")!(undefined)) as {
      catalog: { packages: CatalogPackageViewV1[] }
    }
    const detail = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      envelope.prelude.packageId,
    )) as CatalogPackageViewV1

    expect(Object.keys(browse).sort()).toEqual(["catalog", "channel", "fetchedAt", "source", "version", "via"])
    expect(Object.keys(browse.catalog).sort()).toEqual(["entries", "packages", "version"])
    expect(Object.keys(detail).sort()).toEqual([
      "action",
      "catalogId",
      "components",
      "prerequisites",
      "presentation",
      "verdict",
    ])
    expect(Object.keys(detail.components[0]!).sort()).toEqual([
      "componentId",
      "included",
      "required",
      "role",
      "skipReasonCode",
    ])
    expect(Object.keys(detail.action).sort()).toEqual(["enabled", "kind", "reasonCode"])
    expect(Object.keys(detail.prerequisites).sort()).toEqual(["items", "status"])
    expect(Object.keys(detail.prerequisites.items[0]!).sort()).toEqual(["label", "prerequisiteId", "required"])
    expect(Object.keys(detail.presentation).sort()).toEqual(["description", "displayName", "version"])
    const wire = JSON.stringify({ browse, detail })
    for (const forbidden of ["payloadRef", "headersTemplate", "requiredSecrets", "behavior", "https://"])
      expect(wire).not.toContain(forbidden)
  })

  test("renderer tampering is refused and main reloads signed facts before re-evaluation", async () => {
    const first = await producerPackage()
    const visible = await evaluatePackageForHost(first.envelope, {
      fetchPayload: async () => first.bytes,
    })
    visible.verdict = "compatible"
    visible.action = {
      kind: "install",
      enabled: true,
      reasonCode: "package-compatible",
    }

    const changed = await producerPackage()
    ;(changed.envelope.components[0] as { profileId: string }).profileId = "future-profile"
    let reloads = 0
    let legacyPlannerCalls = 0
    const reevaluated = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: changed.envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "reevaluate-attempt",
      },
      {
        loadVerifiedCatalog: async () => {
          reloads++
          return {
            source: "remote",
            catalog: rawResult(changed.envelope).catalog,
          }
        },
        installLegacy: async () => {
          legacyPlannerCalls++
          return { ok: true }
        },
      },
    )
    expect(reevaluated).toMatchObject({
      ok: false,
      package: {
        verdict: "update-required",
        action: {
          kind: "update-alpha",
          reasonCode: "package-host-update-required",
        },
      },
    })
    expect(reloads).toBe(1)
    expect(legacyPlannerCalls).toBe(0)

    const forged = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: first.envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "forged-attempt",
        verdict: "compatible",
        action: visible.action,
      },
      {
        loadVerifiedCatalog: async () => ({
          source: "remote",
          catalog: rawResult(first.envelope).catalog,
        }),
        installLegacy: async () => {
          legacyPlannerCalls++
          return { ok: true }
        },
      },
    )
    expect(forged).toMatchObject({
      ok: false,
      reason: expect.stringContaining('renderer-supplied key "verdict"'),
      package: { verdict: "blocked" },
    })
    expect(legacyPlannerCalls).toBe(0)

    const absent = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: "package:not-in-the-verified-catalog",
        scope: { scope: "global" },
        attemptId: "absent-attempt",
      },
      {
        loadVerifiedCatalog: async () => ({
          source: "remote",
          catalog: rawResult(first.envelope).catalog,
        }),
        installLegacy: async () => {
          legacyPlannerCalls++
          return { ok: true }
        },
      },
    )
    expect(absent).toMatchObject({
      ok: false,
      reason: "package preflight: catalogId not found in verified Catalog",
      package: { verdict: "blocked" },
    })
    expect(legacyPlannerCalls).toBe(0)

    // 两条失败分支必须 fail-closed:catalog 取不到 / catalog 形状非法时,带 attempt identity 的意图
    // 不得掉进完全不懂 package 的 legacy planner(R1 审计 M2:把 matched:true 改 false 曾全绿)。
    for (const [name, catalog] of [
      ["catalog 不可用", { source: "none" as const }],
      [
        "catalog 形状非法",
        { source: "remote" as const, catalog: { version: "2026-07-30", entries: [{}], packages: "not-an-array" } },
      ],
    ] as const) {
      const failed = await runCatalogInstallWithPackagePreflight(
        {
          catalogId: first.envelope.prelude.packageId,
          scope: { scope: "global" },
          attemptId: `failed-attempt-${name}`,
        },
        {
          loadVerifiedCatalog: async () => catalog as never,
          installLegacy: async () => {
            legacyPlannerCalls++
            return { ok: true }
          },
        },
      )
      expect(failed, name).toMatchObject({ ok: false, package: { verdict: "blocked" } })
      expect(legacyPlannerCalls, name).toBe(0)
    }
  })

  // §5.1 门一,**已翻正向**(`#759` re-vendor 到 alpha-web@6e0db57d)。
  // 走的是真实 refresh → browse → detail 生产链,不是直接调解码器:它同时证明这个结论会一路
  // 传到 renderer 能看到的 safe view。信封与 payload 都是产物原字节,零结构补丁 —— 上游哪天
  // 产出宿主拒收的信封,这条会响亮地红,而不是被一行手工补丁掩盖。
  test("the pinned producer artifact is accepted end-to-end through the real read path", async () => {
    const { envelope, payloadByDigest, publishedVerdict } = await vendoredProducerPackage(
      "expected.mcp-remote.compiled.json",
    )
    expect(Object.hasOwn(envelope, "root"), "producer 必须已经产出 root").toBe(true)

    const fetched: string[] = []
    const refresh = () =>
      evaluateRemoteCatalogPackages(rawResult(envelope), {
        packageInstallability: {
          fetchPayload: async (ref) => {
            fetched.push(ref.sha256)
            const payload = payloadByDigest.get(ref.sha256)
            if (!payload) throw new Error(`producer corpus has no payload for ${ref.sha256}`)
            return payload
          },
        },
      })
    const handlers = registeredHandlers(refresh)
    const browse = (await handlers.get("ext-remote-catalog")!(undefined)) as {
      catalog: { packages: CatalogPackageViewV1[] }
    }
    const detail = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      envelope.prelude.packageId,
    )) as CatalogPackageViewV1

    // 宿主的判决必须与**发布端自己发布的判决**一致 —— 判据来自上游,不是我们这边另写一份。
    expect(publishedVerdict).toBe("compatible")
    expect(browse.catalog.packages.map((view) => view.verdict)).toEqual([publishedVerdict])
    expect(detail.verdict).toBe(publishedVerdict)
    expect(detail.action).toEqual({
      kind: "resolve-prerequisite",
      enabled: true,
      reasonCode: "package-prerequisite-required",
    })
    // leaf 列表完整:签名信封的每一个组件都在,且全部 included、零 skip。
    expect(detail.components).toEqual(
      envelope.components.map((component) => ({
        componentId: component.id,
        role: component.id === envelope.root ? "root" : "leaf",
        required: component.required,
        included: true,
        skipReasonCode: null,
      })),
    )
    // payload 真的按签名 digest 取过 —— 拒绝路径是 0 次,这条必须非 0,否则「接受」只是没走到。
    // (browse 与 detail 各自 refresh 一次,所以按去重集合比对。)
    expect([...new Set(fetched)]).toEqual(envelope.components.map((component) => component.payloadRef.sha256))
    expect(fetched.length).toBeGreaterThan(0)
    // 签名的密钥前置一路传到 safe view,而注入目标(headersTemplate)不上线。
    expect(detail.prerequisites.status).toBe("required-action")
    expect(detail.prerequisites.items.map((item) => item.prerequisiteId).sort()).toEqual([
      "mcp:generic-remote#A_KEY",
      "mcp:generic-remote#B_TOKEN",
    ])
    expect(JSON.stringify(detail)).not.toContain("headersTemplate")
  })

  /**
   * 同一份产物的 Bundle 语料(root agent + skill leaf + optional mcp leaf)。`#697` 翻开了 §5.1
   * 门二:这张图现在必须一路走到**可点的安装动作**,并且每个组件的 payload 都真的被按签名 digest
   * 取过 —— 门二时代这里是零 fetch,所以「取过几次」正是翻开与否的判据,不是装饰。
   */
  test("the pinned Bundle artifact reaches an enabled install action with every leaf fetched", async () => {
    const { envelope, payloadByDigest, publishedVerdict } = await vendoredProducerPackage(
      "expected.bundle.compiled.json",
    )
    expect(envelope.components.length).toBeGreaterThan(1)
    expect(publishedVerdict).toBe("compatible")

    const fetched: string[] = []
    const refresh = () =>
      evaluateRemoteCatalogPackages(rawResult(envelope), {
        packageInstallability: {
          fetchPayload: async (ref) => {
            fetched.push(ref.sha256)
            return payloadByDigest.get(ref.sha256) ?? new Uint8Array()
          },
        },
      })
    const handlers = registeredHandlers(refresh)
    const detail = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      envelope.prelude.packageId,
    )) as CatalogPackageViewV1

    expect(detail.verdict).toBe("compatible")
    expect(detail.action.enabled).toBe(true)
    expect(detail.action.kind).toBe("resolve-prerequisite")
    // 图被合同接受:每个组件都在列表里,root/leaf 角色正确,零 skip。若 re-vendor 没做对,
    // 这里会是 `package-invalid` 且 components 为空。
    expect(detail.components).toEqual(
      envelope.components.map((component) => ({
        componentId: component.id,
        role: component.id === envelope.root ? "root" : "leaf",
        required: component.required,
        included: true,
        skipReasonCode: null,
      })),
    )
    expect(detail.components.filter((component) => component.role === "root")).toHaveLength(1)
    // 每个组件的 payload 都取过(去重后 = 签名里声明的那一组 digest)。
    expect([...new Set(fetched)].sort()).toEqual(
      envelope.components.map((component) => component.payloadRef.sha256).sort(),
    )
    // 门二已经删掉,而不是换成一个更弱的谓词:整个仓里不该再有那个理由码。
    expect(CATALOG_PACKAGE_REASON_CODES as readonly string[]).not.toContain(
      "package-bundle-activation-pending",
    )
  })

  /**
   * §4.3:optional 且**宿主不支持**的 leaf 必须精确标 skipped,并带 decoder 自己的原因码。
   * 语料里没有这样的组件(上游只发布宿主支持的 profile),所以从**真实 Bundle 字节**派生一个
   * 负向:把最后一个 optional leaf 的 capability 换成本 build 不认识的 token,并同步签名并集
   * (§4.3 第一层要求并集含全部组件)。这是**把语料变坏**,不是补字段让它通过。
   * 违规项放在集合最后一个 —— 「只看第一个元素」的实现要能被抓住。
   */
  test("an optional leaf this build cannot support is marked skipped, verbatim from the decoder", async () => {
    const { envelope, payloadByDigest } = await vendoredProducerPackage("expected.bundle.compiled.json")
    const optional = envelope.components.filter((component) => !component.required)
    expect(optional.length, "语料需要至少一个 optional leaf").toBeGreaterThan(0)
    const target = optional.at(-1)!
    expect(envelope.components.at(-1)!.id, "违规项必须不是第一个元素").toBe(target.id)
    ;(target as { capabilities: string[] }).capabilities = ["alpha.future-unsupported.v1"]
    ;(envelope as { capabilities: string[] }).capabilities = [
      ...new Set(envelope.components.flatMap((component) => component.capabilities)),
    ].sort()

    const refresh = () =>
      evaluateRemoteCatalogPackages(rawResult(envelope), {
        packageInstallability: {
          fetchPayload: async (ref) => payloadByDigest.get(ref.sha256) ?? new Uint8Array(),
        },
      })
    const handlers = registeredHandlers(refresh)
    const detail = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      envelope.prelude.packageId,
    )) as CatalogPackageViewV1

    const skipped = detail.components.find((component) => component.componentId === target.id)!
    expect(skipped.included).toBe(false)
    expect(skipped.skipReasonCode).toBe("component-capability-unsupported")
    // 精确:**只有**它被跳过,其余组件照常在列。
    expect(detail.components.filter((component) => !component.included).map((c) => c.componentId)).toEqual([
      target.id,
    ])
    expect(detail.components).toHaveLength(envelope.components.length)
  })

  test("the real bundled Catalog has no package instance; this gate marks its constructed reachability", () => {
    expect(Object.hasOwn(bundledCatalog, "packages")).toBe(false)
    expect((bundledCatalog as { entries: unknown[] }).entries.length).toBeGreaterThan(0)
  })
})
