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
// 刷新器只写「已下载」(LKG);fork 前钉成「已应用」的是 spawnLocalServer → pinAppliedCatalog(alpha-live-allowlist.ts)。
import { app } from "electron"
import { getAuthIdentityTag, isStoredTokenExpired } from "./alpha-auth"
import { readCatalogSnapshot } from "./alpha-live-allowlist"
import { syncLiveAllowlist } from "./alpha-platform-models"
import { getLogger } from "./logging"

export type CatalogRefreshReason = "boot" | "identity-change" | "interval" | "manual"
export type DownloadedCatalogChange = { platformChanged: boolean; byokChanged: boolean }

const INTERVAL_MS = 30 * 60_000

let inFlight = false
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

/** 请求一次目录刷新。同步返回 `void`,永不抛错;调用方不得 await 任何东西。 */
export function requestCatalogRefresh(reason: CatalogRefreshReason): void {
  try {
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
      if (after !== undefined && after !== before) {
        for (const cb of listeners) {
          try {
            cb({ platformChanged: true, byokChanged: false })
          } catch (error) {
            getLogger().warn("catalog-refresher: downloaded-catalog listener failed", { error: String(error) })
          }
        }
      }
      if (rerunForIdentity) {
        rerunForIdentity = false
        runRound("identity-change")
      }
    })
}
