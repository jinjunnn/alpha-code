// REQ-001:B 网关 edition 白名单的本地缓存(文件桥,复用 A6 的「main 写 / sidecar 读」模式)。
//
// 网关 GET /v1/models 是「允许哪些 provider / model」的权威源(edition-scoped)。main 在启动 /
// 登录后 respawn / picker 打开时同步一份到 <userData>/alpha-live-models.json;fork 期的
// buildAlphaModelConfig(sidecar)与 picker 的 effective catalog(main)都读这份缓存装配显隐。
// 缓存缺失 / 损坏 / 网关不可达 → 回退内置 snapshot(alpha-models.json),picker 永不空白(B20)。
//
// electron-free:sidecar(utilityProcess)经 alpha-models.ts 读;main 经 alpha-platform-models.ts 写。

import * as fs from "node:fs"
import * as path from "node:path"

export type LiveAllowlistModel = { id: string; provider?: string; minPlan?: string }

export type LiveAllowlist = {
  /** ISO 时间戳(同步成功时刻)。 */
  fetchedAt: string
  /** 网关判定的 edition(cn/intl/…)。 */
  edition?: string
  /** 内置 BYOK 目录 provider 白名单;null = 不限制。**用户自定义节点不受此约束**(2026-07-03 拍板)。 */
  byokProviders: string[] | null
  /** edition-scoped 平台模型清单(registry 真实 id)。 */
  models: LiveAllowlistModel[]
}

const FILE = "alpha-live-models.json"

export function liveAllowlistPath(userDataPath: string): string {
  return path.join(userDataPath, FILE)
}

/** 读缓存;缺失 / 坏 JSON / 形状不对 → null(调用方回退内置 snapshot,fail-open)。 */
export function readLiveAllowlist(userDataPath: string): LiveAllowlist | null {
  try {
    const raw = fs.readFileSync(liveAllowlistPath(userDataPath), "utf8")
    const parsed = JSON.parse(raw) as LiveAllowlist
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) return null
    if (parsed.byokProviders !== null && !Array.isArray(parsed.byokProviders)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写缓存(仅同步成功时调用——失败保留 last-known,不清空)。 */
export function writeLiveAllowlist(userDataPath: string, data: LiveAllowlist): void {
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.writeFileSync(liveAllowlistPath(userDataPath), JSON.stringify(data))
}
