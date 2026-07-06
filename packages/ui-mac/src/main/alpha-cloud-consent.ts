// B16(ADR-021 §4 显式通道挂钩)—— 首次云派发 per 项目的 PIPL 同意门·纯核。
//
// 定位:显式通道(向云传项目 diff/任务文本)在**每个项目首次派发**时弹一次同意,记录于该项目
// `.alpha/prefs.json` 的 cloudConsent(ADR-019 落点)。隐式通道(platform 代付每条 prompt 出境)
// 的义务是**告知**、不是阻断(ADR-021 §3),由 alpha-web 登录流承担,不在此。
//
// 版本化:告知内容实质变更(出境范围扩大等)时 bump CLOUD_CONSENT_VERSION → 旧同意失效、重新弹。
// fs I/O 在 alpha-workdir(readProjectPrefs/writeProjectPrefs),对话框在 cloud-ipc;本模块纯、可单测。

export const CLOUD_CONSENT_VERSION = 1

export type CloudConsent = { version: number; acceptedAt: string }
export type ProjectPrefs = { cloudConsent?: CloudConsent; [k: string]: unknown }

/** 安全解析 .alpha/prefs.json 文本;缺失/损坏/非对象 → {}(不抛,不误判为已同意)。 */
export function parsePrefs(json: string | null | undefined): ProjectPrefs {
  if (!json) return {}
  try {
    const p: unknown = JSON.parse(json)
    return p && typeof p === "object" && !Array.isArray(p) ? (p as ProjectPrefs) : {}
  } catch {
    return {}
  }
}

/** 已同意 ⟺ 记录存在且版本 == 当前(旧版本告知 = 视作未同意,重新弹)。 */
export function hasCloudConsent(prefs: ProjectPrefs): boolean {
  return prefs.cloudConsent?.version === CLOUD_CONSENT_VERSION
}

/** 合并写入(保留 prefs 其它字段;只覆盖 cloudConsent)。iso 由调用方注入(便于单测确定性)。 */
export function withCloudConsent(prefs: ProjectPrefs, iso: string): ProjectPrefs {
  return { ...prefs, cloudConsent: { version: CLOUD_CONSENT_VERSION, acceptedAt: iso } }
}
