// REQ-237 `#1556`:picker / composer 测试用的 EffectiveCatalog —— 由**生产投影**装配,不手写目录形状。
//
// 此前这些测试把随包 alpha-models.json 原样 spread 成 EffectiveCatalog;`#1556` 起随包文件只剩 BYOK 首启引导
// (ByokCatalogV1 形状)与平台 provider 外壳,平台模型只来自已应用的网关快照。这里照生产那条路拼一份「已应用」目录:
//   · 平台段 = projectPlatformModels(上游 V3 producer fixture 的行)—— display / pricing 是上游字节,不是替身;
//   · BYOK 段 = projectByokProviders(随包首启引导)—— 端点 / Key 名来自 App 内置适配器表;
//   · 已下载 = 已应用(没有待生效的新清单)。
import type { CatalogSnapshot } from "../src/main/alpha-live-allowlist"
import { projectPlatformModels } from "../src/main/alpha-live-allowlist"
import { projectByokProviders } from "../src/main/alpha-models"
import bundled from "../src/main/alpha-models.json"
import producer from "../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v3/fixtures/producer/model-catalog.json"
import type { EffectiveCatalog } from "../src/shared/alpha-model-types"

export const V3_PRODUCER_CATALOG = producer.value

/** 上游 V3 producer fixture 落成的平台快照(与 syncLiveAllowlist 写 LKG 的映射逐字段相同)。 */
export function v3Snapshot(fetchedAt = "2026-10-30T00:00:00Z"): CatalogSnapshot {
  return {
    fetchedAt,
    edition: producer.value.edition,
    pricingBasisModelId: producer.value.pricing_basis_model_id,
    models: producer.value.data.map((row) => ({
      id: row.id,
      provider: row.provider,
      minPlan: row.min_plan,
      pricing: row.pricing_multiplier,
      display: row.display as CatalogSnapshot["models"][number]["display"],
    })),
  }
}

export function effectiveCatalogFixture(): EffectiveCatalog {
  const snapshot = v3Snapshot()
  const byokProviders = projectByokProviders(bundled.byokCatalog as never)
  return {
    defaultModel: bundled.defaultModel,
    defaultPlatformModel: bundled.defaultPlatformModel,
    platformProvider: bundled.platformProvider,
    platformModels: projectPlatformModels(snapshot),
    byokProviders,
    presetIds: byokProviders.filter((provider) => provider.preset).map((provider) => provider.id),
    liveSync: { status: "cache", fetchedAt: snapshot.fetchedAt, edition: snapshot.edition },
    pricingBasisModelId: snapshot.pricingBasisModelId,
    applied: { platformFetchedAt: snapshot.fetchedAt, byokVersion: bundled.byokCatalog.catalog_version },
    downloaded: { platformFetchedAt: snapshot.fetchedAt, byokVersion: bundled.byokCatalog.catalog_version },
  }
}
