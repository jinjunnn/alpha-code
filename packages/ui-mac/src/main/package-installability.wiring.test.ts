// REQ-128 production wiring gate. The repository's shipped Catalog currently has no packages[]
// instances, so the packages below are explicit host-owned constructions that reuse the pinned
// alpha-web corpus's identity. This is a reachability harness for the new path, not a claim that
// production traffic already exercises it.
//
// The one place the *actual* vendored producer bytes are read is the §5.1 transition gate at the
// bottom, which asserts they are refused until the compiler emits a v2 envelope.

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import bundledCatalog from "../renderer/extensions/alpha-catalog.json"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"
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
 * The pinned producer output exactly as vendored. Under the v2 host contract it carries no `root`,
 * so it is expected to be **refused** until P2-B′ re-vendors a v2 compiler artifact. It is never
 * patched into compliance here — see the transition gate at the bottom of this file.
 */
const vendoredProducerEnvelope = async () =>
  structuredClone(
    (
      (await Bun.file(resolve(artifact, "expected.mcp-remote.compiled.json")).json()) as {
        envelope: AlphaPackageEnvelopeV1
      }
    ).envelope,
  )

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

  // §5.1 门一。旧 vendored producer 产物在 v2 合同下应当被拒 —— 这是正确行为,不是回归。
  // 这里走的是**真实** refresh/detail 生产链,不是直接调解码器,所以它同时证明拒绝会一路
  // 传到 renderer 能看到的 safe view。P2-B′ re-vendor 之后本条会红,由那张票翻成正向。
  test("the pinned producer artifact is refused end-to-end through the real read path", async () => {
    const envelope = await vendoredProducerEnvelope()
    expect(Object.hasOwn(envelope, "root"), "producer 已产出 root,请翻转 §5.1 门一").toBe(false)

    const refresh = () =>
      evaluateRemoteCatalogPackages(rawResult(envelope), {
        packageInstallability: {
          fetchPayload: async () => {
            throw new Error("payload must never be fetched for a refused envelope")
          },
        },
      })
    const handlers = registeredHandlers(refresh)
    const detail = (await handlers.get(PACKAGE_DETAIL_IPC_CHANNEL)!(
      undefined,
      envelope.prelude.packageId,
    )) as CatalogPackageViewV1
    expect(detail.verdict).toBe("blocked")
    expect(detail.action).toEqual({ kind: "none", enabled: false, reasonCode: "package-invalid" })
  })

  test("the real bundled Catalog has no package instance; this gate marks its constructed reachability", () => {
    expect(Object.hasOwn(bundledCatalog, "packages")).toBe(false)
    expect((bundledCatalog as { entries: unknown[] }).entries.length).toBeGreaterThan(0)
  })
})
