// REQ-237 `#1555`(方案 docs/design/req236-catalog-and-model.md §2.1 / §2.10)—— 远程模型目录的**唯一**刷新入口。MAIN-ONLY。
//
// 此前有三个散落的刷新点:启动(fire-and-forget)、**每次** sidecar 换代前 `await syncLiveAllowlist`
// (每 10 分钟的令牌续期都先白等远端目录,owner 机实测 23 次平均 4.0s、6 次等满 8s)、零调用的
// `models-platform-live` IPC。现在只有这里一个入口,它:
//
//   - 同步返回、永不抛错、永不被 respawn / 发送 / 启动 await —— 目录请求挂死也挡不住任何一次 fork;
//   - 只在四个触发点发起:boot、身份**真的**变化(续期每次都会触发 onChanged,标签不变 = 纯续期,不拉)、
//     每 30 分钟、manual;首试 8s、超时后 1s 补试一次(在 syncLiveAllowlist 里,计入同一轮),之后等下一个触发点;
//   - 冷启动时存着的令牌已过期(App 关了超过一个续期周期就是这样):boot 那一轮先不发 —— 网关对坏 bearer
//     回退默认 edition(alpha-platform worker.ts `GET /v1/models` 的 optional auth),拉回来的是别人的清单,而
//     纯续期不再重拉,它会一直钉到下一个触发点。改为等开机续期落定:续期结束(成功或失败)都会走 onChanged
//     → requestCatalogRefresh("identity-change"),那时用当刻的令牌补发这一轮;续期失败就照旧按过期令牌拉,不饿死。
//   - 单飞:同一时刻至多一轮在途。在途时到来的触发并入在途那一轮;只有身份变化例外 —— 在途那一轮带的是旧身份,
//     它的结果由 syncLiveAllowlist 的序号 + 身份仲裁丢弃(不写盘、不改 health),本模块在它落定后立刻补一轮。
//
// `#1556`(方案 §2.1 / §2.3):两份文档 —— 平台目录 V3(`/v1/models`,有登录态就带 bearer)与 BYOK 预置目录 v1
// (`/v1/byok-catalog`,**从不带凭据**)。每份文档各自单飞;BYOK 文档与身份无关,所以纯身份变化不拉它、冷启动也
// 不等续期。BYOK 文档经 adoptByokCatalog(本文件,纯函数)按方案 §2.3 规则 1–5 采纳;拉取失败、校验失败、未登录
// 都不写 LKG,已有条目从不因失败减少(I5)。两份的刷新结局按文档分别记(alpha-catalog-health.ts,I10)。
//
// 刷新器只写「已下载」(LKG);fork 前钉成「已应用」的是 spawnLocalServer → pinAppliedCatalog(alpha-live-allowlist.ts)。
import { app } from "electron"
import { decodeJsonContract, type ByokCatalogV1 } from "@alpha-code/contracts-consumer"
import { getAuthIdentityTag, isStoredTokenExpired } from "./alpha-auth"
import { reportCatalogRefresh } from "./alpha-catalog-health"
import { resolveEndpoints } from "./alpha-endpoints"
import { downloadedByokCatalog, readCatalogSnapshot, writeByokCatalogLkg } from "./alpha-live-allowlist"
import { syncLiveAllowlist } from "./alpha-platform-models"
import { BYOK_ADAPTERS, type ByokAdapter } from "./byok-adapters"
import { getLogger } from "./logging"
import { httpErrorCode } from "./platform-error-code"
import { ALPHA_PATHS } from "../shared/alpha-config"

export type CatalogRefreshReason = "boot" | "identity-change" | "interval" | "manual"
export type DownloadedCatalogChange = { platformChanged: boolean; byokChanged: boolean }

const INTERVAL_MS = 30 * 60_000

let inFlight = false
let byokInFlight = false
let rerunForIdentity = false
let bootWaitsForRenewal = false
let identity: string | undefined
let interval: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(change: DownloadedCatalogChange) => void>()

/** 订阅「已下载目录变了」。默认无人订阅;返回退订函数。 */
export function onDownloadedCatalogChanged(cb: (change: DownloadedCatalogChange) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function notify(change: DownloadedCatalogChange) {
  for (const cb of listeners) {
    try {
      cb(change)
    } catch (error) {
      getLogger().warn("catalog-refresher: downloaded-catalog listener failed", { error: String(error) })
    }
  }
}

/** 请求一次目录刷新。同步返回 `void`,永不抛错;调用方不得 await 任何东西。 */
export function requestCatalogRefresh(reason: CatalogRefreshReason): void {
  try {
    // BYOK 文档不带凭据、与身份无关:除纯身份变化外的每个触发点都拉,冷启动也不等开机续期。
    if (reason !== "identity-change") refreshByok(reason)
    if (reason === "boot") {
      identity = getAuthIdentityTag()
      if (!interval) {
        interval = setInterval(() => requestCatalogRefresh("interval"), INTERVAL_MS)
        interval.unref?.()
      }
      if (isStoredTokenExpired()) {
        bootWaitsForRenewal = true
        return
      }
    }
    if (reason === "identity-change") {
      const next = getAuthIdentityTag()
      if (next === identity && !bootWaitsForRenewal) return
      bootWaitsForRenewal = false
      identity = next
      if (inFlight) {
        rerunForIdentity = true
        return
      }
    }
    if (inFlight) return
    runRound(reason)
  } catch (error) {
    getLogger().warn("catalog-refresher: refresh request failed", { reason, error: String(error) })
  }
}

function runRound(reason: CatalogRefreshReason) {
  inFlight = true
  const userDataPath = app.getPath("userData")
  const before = readCatalogSnapshot(userDataPath)?.fetchedAt
  void syncLiveAllowlist(userDataPath)
    .catch((error) => getLogger().warn("catalog-refresher: refresh round failed", { reason, error: String(error) }))
    .finally(() => {
      inFlight = false
      const after = readCatalogSnapshot(userDataPath)?.fetchedAt
      if (after !== undefined && after !== before) notify({ platformChanged: true, byokChanged: false })
      if (rerunForIdentity) {
        rerunForIdentity = false
        runRound("identity-change")
      }
    })
}

// ── BYOK 预置目录(`#1556`)───────────────────────────────────────────────────────────────────────

export type ByokAdoption =
  | { kind: "adopted"; catalog: ByokCatalogV1; skippedProviders: string[] }
  | { kind: "not-newer"; version: number }
  | { kind: "rejected" }

/** 方案 §2.3 的采纳规则(纯函数):
 *  1. 信封不合 schema(含 `schema_version` 不是 1)→ 整份拒绝。ByokCatalogV1 每层 `additionalProperties:false`,
 *     所以带 `baseURL` / `keyEnv` / `compat` / `npm` 的文档在这里就被拒(I3);
 *  2. `catalog_version` ≤ `current`(= max(LKG, 随包首启引导))→ 不采纳(防回滚;撤一次坏发布 = 发一个更高版本);
 *  3. provider 不在 App 适配器表 → 跳过该 provider(调用方记日志);
 *  4. 档位出现允许集外的选项键 → 不采纳。允许集 `reasoningEffort | reasoning | thinking` 由 ByokCatalogV1 自己封闭,
 *     所以越界的文档已在规则 1 整份拒绝(不会出现「半应用」的模型);
 *  5. 随包 BYOK 段只作首启引导 —— 体现在 `current` 含随包版本,以及钉住时取版本高者(alpha-live-allowlist.ts)。 */
export function adoptByokCatalog(text: string, adapters: readonly Pick<ByokAdapter, "id">[], current: number): ByokAdoption {
  let doc: ByokCatalogV1
  try {
    doc = decodeJsonContract("ByokCatalogV1", text, "byok-catalog")
  } catch {
    return { kind: "rejected" }
  }
  if (doc.catalog_version <= current) return { kind: "not-newer", version: doc.catalog_version }
  const known = new Set(adapters.map((adapter) => adapter.id))
  return {
    kind: "adopted",
    catalog: { ...doc, providers: doc.providers.filter((provider) => known.has(provider.id)) },
    skippedProviders: doc.providers.filter((provider) => !known.has(provider.id)).map((provider) => provider.id),
  }
}

function refreshByok(reason: CatalogRefreshReason) {
  if (byokInFlight) return
  byokInFlight = true
  void syncByokCatalog(app.getPath("userData"))
    .catch((error) => getLogger().warn("catalog-refresher: byok refresh round failed", { reason, error: String(error) }))
    .finally(() => {
      byokInFlight = false
    })
}

type ByokFetch = { text: string } | { error: string }

/** 拉 BYOK 文档。**不带任何凭据**(I4):请求头里没有 authorization,结构上无法按账户收窄。 */
async function fetchByokCatalog(attempt: number): Promise<ByokFetch> {
  const base = resolveEndpoints().platform
  if (!base) return { error: "no-platform-endpoint" }
  const url = new URL(`${base}${ALPHA_PATHS.byokCatalog}`)
  const started = Date.now()
  let status: number | undefined
  let exception: string | undefined
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
    status = res.status
    if (!res.ok) return { error: await httpErrorCode(res) }
    return { text: await res.text() }
  } catch (error) {
    exception = error instanceof Error ? error.name : "unknown"
    return { error: exception === "TimeoutError" ? "timeout" : "network" }
  } finally {
    getLogger().log("catalog-refresher: byok catalog request completed", {
      origin: url.origin,
      path: url.pathname,
      method: "GET",
      attempt,
      durationMs: Date.now() - started,
      ...(status === undefined ? {} : { status }),
      ...(exception === undefined ? {} : { exception }),
    })
  }
}

/** 一轮 BYOK 刷新:首试最多 8 秒,超时约 1 秒后补试一次;只有采纳成功才写 LKG。每条出路都落到 byok 那一格结局。 */
async function syncByokCatalog(userDataPath: string): Promise<void> {
  let fetched = await fetchByokCatalog(1)
  if ("error" in fetched && fetched.error === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    fetched = await fetchByokCatalog(2)
  }
  if ("error" in fetched) {
    reportCatalogRefresh("byok", fetched.error)
    return
  }
  const adoption = adoptByokCatalog(fetched.text, BYOK_ADAPTERS, downloadedByokCatalog(userDataPath).byok.catalog_version)
  if (adoption.kind === "rejected") {
    reportCatalogRefresh("byok", "contract-incompatible")
    return
  }
  if (adoption.kind === "not-newer") {
    reportCatalogRefresh("byok", null)
    return
  }
  if (adoption.skippedProviders.length)
    getLogger().warn("catalog-refresher: byok catalog providers skipped (no built-in adapter)", {
      providers: adoption.skippedProviders,
    })
  try {
    if (!writeByokCatalogLkg(userDataPath, adoption.catalog)) {
      reportCatalogRefresh("byok", "snapshot-rejected")
      return
    }
  } catch (error) {
    getLogger().warn("catalog-refresher: byok catalog write failed", { error: String(error) })
    reportCatalogRefresh("byok", "cache-write-failed")
    return
  }
  getLogger().log("catalog-refresher: byok catalog adopted", { catalogVersion: adoption.catalog.catalog_version })
  reportCatalogRefresh("byok", null)
  notify({ platformChanged: false, byokChanged: true })
}
