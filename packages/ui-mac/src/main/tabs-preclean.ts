// REQ-014:冷启动「Not found / 整屏 ErrorPage」毒键预清(方案②,S17 实证「删毒键即愈」)。
// 上游冻结 tabs.tsx 在 renderer 侧恢复 `opencode.global.dat` 的 `tabs`/`tabs.recent` 路由,alpha 无
// 恢复层可插(方案① renderer 守卫已被 S17 证伪:整屏态 alpha 子组件全不挂)。修 = main 预清,两级:
//   tier-1 格式级(同步):旧版序列化毒键 —— session tab 缺 dirBase64 → tabHref 生成 `/undefined/...`
//     → 上游 titlebar pathKey(undefined) throw → 整屏 ErrorPage 循环(形态 B,S17 证据原件即此形状);
//   tier-2 存在性(serverReady 后,时限内 fail-open):tab 指向已删会话 → 上游 Not found 白屏(形态 A)。
// renderer 首读经 store-get gate(ipc.ts)等预清完成 —— A1 window-first 不回退:窗口/splash/侧栏照常
// 先开,只有 tabs 恢复数据最多晚几秒(时限硬界)。
//
// 契约锚(上游冻结面,ADR-020 re-freeze 时按 §5 复查):
//   store = "opencode.global.dat",键 "tabs" / "tabs.recent"(app/src/utils/persist.ts:26 GLOBAL_STORAGE);
//   tabKey = `${server}\n/${dirBase64}/session/${sessionId}` | `draft:${draftID}`(app/src/context/tabs.tsx:36-39);
//   dirBase64 = URL-safe base64 无填充(core/src/util/encode.ts);**worktree "/" → "Lw" 是合法全局约定
//   (ADR-008),校验只看形状、绝不按解码值剔**。
// 纪律:一切拿不准 = fail-open 保持原样(绝不越修越坏);每次剔除留痕(B11 反静默)。
// 纯逻辑与编排分离:本文件不 import electron,全部依赖注入 → 可单测。

export type PrecleanDrop = { where: "tabs" | "recent"; reason: string; detail: string }

const B64URL = /^[A-Za-z0-9_-]+$/
const SESSION_ID = /^[A-Za-z0-9_-]+$/

type AnyTab = Record<string, unknown>

function isValidSessionTab(t: AnyTab): boolean {
  return (
    t.type === "session" &&
    typeof t.server === "string" &&
    t.server.length > 0 &&
    !t.server.includes("\n") &&
    typeof t.dirBase64 === "string" &&
    B64URL.test(t.dirBase64) &&
    typeof t.sessionId === "string" &&
    SESSION_ID.test(t.sessionId)
  )
}

function isValidDraftTab(t: AnyTab): boolean {
  return t.type === "draft" && typeof t.draftID === "string" && (t.draftID as string).length > 0
}

/** 重算上游 tabKey;算不出(未知类型/形状不合法)返回 undefined。 */
export function tabKeyOf(t: AnyTab): string | undefined {
  if (isValidDraftTab(t)) return `draft:${t.draftID as string}`
  if (isValidSessionTab(t)) return `${t.server as string}\n/${t.dirBase64 as string}/session/${t.sessionId as string}`
  return undefined
}

/** store 值可能是 JSON 字符串(renderer AsyncStorage 写入形态)或裸对象;编解码对称,认不出返回 null(fail-open)。 */
export function decodeStoreValue(raw: unknown): { value: unknown; reencode: (v: unknown) => unknown } | null {
  if (typeof raw === "string") {
    try {
      return { value: JSON.parse(raw), reencode: (v) => JSON.stringify(v) }
    } catch {
      return null
    }
  }
  if (raw !== null && typeof raw === "object") return { value: raw, reencode: (v) => v }
  return null
}

export type SanitizeResult = {
  tabs: unknown[]
  recent: Record<string, unknown>
  /** tabs 数组是否有改动(须写回)。 */
  tabsChanged: boolean
  /** recent 是否有改动(须写回)。 */
  recentChanged: boolean
  drops: PrecleanDrop[]
}

/**
 * tier-1 格式级清洗(纯函数)。剔除**可证坏**的条目:非对象、session 缺 server/dirBase64/sessionId、
 * draft 缺 draftID;未知 type 的对象条目 fail-open 保留(冻结前端只有两型,但绝不替未来格式做决定)。
 * recent:key 不指向任何幸存 tab 即清 —— 与上游 tabs.tsx:102 自身的清理语义一致(mismatch 非崩溃向,
 * 预清只是把旧格式 key 提前收敛);存在未知型幸存 tab 时 fail-open 不清(其 key 无法重算)。
 */
export function sanitizeTabsValue(tabsValue: unknown, recentValue: unknown): SanitizeResult | null {
  if (!Array.isArray(tabsValue)) return null // tabs 整体不可读 → fail-open,一律不动
  const drops: PrecleanDrop[] = []
  const kept: unknown[] = []
  let hasUnknownType = false
  for (const entry of tabsValue) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      drops.push({ where: "tabs", reason: "non-object entry", detail: JSON.stringify(entry)?.slice(0, 120) ?? String(entry) })
      continue
    }
    const t = entry as AnyTab
    if (t.type === "session") {
      if (isValidSessionTab(t)) kept.push(t)
      else
        drops.push({
          where: "tabs",
          reason: "malformed session tab (missing/invalid server|dirBase64|sessionId — legacy serialization, REQ-014 形态 B)",
          detail: JSON.stringify(t).slice(0, 200),
        })
      continue
    }
    if (t.type === "draft") {
      if (isValidDraftTab(t)) kept.push(t)
      else drops.push({ where: "tabs", reason: "malformed draft tab (missing draftID)", detail: JSON.stringify(t).slice(0, 200) })
      continue
    }
    hasUnknownType = true // 未知类型:fail-open 保留
    kept.push(t)
  }

  const recentObj = recentValue !== null && typeof recentValue === "object" && !Array.isArray(recentValue) ? ({ ...(recentValue as Record<string, unknown>) } as Record<string, unknown>) : {}
  let recentChanged = false
  const recentKey = recentObj.key
  if (typeof recentKey === "string" && recentKey.length > 0 && !hasUnknownType) {
    const known = new Set(kept.map((t) => tabKeyOf(t as AnyTab)).filter((k): k is string => !!k))
    if (!known.has(recentKey)) {
      drops.push({ where: "recent", reason: "recent key matches no surviving tab (stale/legacy format)", detail: recentKey.slice(0, 200) })
      delete recentObj.key
      recentChanged = true
    }
  }

  const tabsChanged = kept.length !== tabsValue.length
  if (!tabsChanged && !recentChanged) return { tabs: kept, recent: recentObj, tabsChanged, recentChanged, drops }
  return { tabs: kept, recent: recentObj, tabsChanged, recentChanged, drops }
}

/**
 * tier-2 存在性过滤(纯逻辑,查询注入)。listSessionIds 返回该目录的会话 id 集;返回 null = 查询失败/
 * 分页未尽等不确定态 → 该目录整组 fail-open 保留。只动合法 session tab;draft/未知型不碰。
 */
export async function dropDanglingSessionTabs(
  tabs: unknown[],
  listSessionIds: (dirBase64: string) => Promise<ReadonlySet<string> | null>,
): Promise<{ tabs: unknown[]; drops: PrecleanDrop[] }> {
  const dirs = new Map<string, ReadonlySet<string> | null>()
  for (const t of tabs) {
    const tab = t as AnyTab
    if (isValidSessionTab(tab) && !dirs.has(tab.dirBase64 as string)) dirs.set(tab.dirBase64 as string, null)
  }
  await Promise.all(
    [...dirs.keys()].map(async (dir) => {
      try {
        dirs.set(dir, await listSessionIds(dir))
      } catch {
        dirs.set(dir, null)
      }
    }),
  )
  const drops: PrecleanDrop[] = []
  const kept = tabs.filter((t) => {
    const tab = t as AnyTab
    if (!isValidSessionTab(tab)) return true
    const ids = dirs.get(tab.dirBase64 as string)
    if (ids === null || ids === undefined) return true // 查询失败/不确定 → fail-open
    if (ids.has(tab.sessionId as string)) return true
    drops.push({
      where: "tabs",
      reason: "dangling session tab (session no longer exists — REQ-014 形态 A)",
      detail: JSON.stringify({ server: tab.server, dirBase64: tab.dirBase64, sessionId: tab.sessionId }),
    })
    return false
  })
  return { tabs: kept, drops }
}

// ---------- 编排(依赖注入;index.ts 接线真实 store/logger/SDK) ----------

export const GLOBAL_RENDERER_STORE = "opencode.global.dat"
export const TABS_KEY = "tabs"
export const TABS_RECENT_KEY = "tabs.recent"

export type TabsPrecleanDeps = {
  getValue: (key: string) => unknown
  setValue: (key: string, value: unknown) => void
  log: (line: string) => void
  /** serverReady 的 promise 化;调用方不 race,超时由本模块统一管。 */
  awaitServer: () => Promise<{ url: string; username: string | null; password: string | null } | null>
  /** 按目录列会话 id;null = 不确定(错误/分页未尽)→ fail-open。 */
  fetchSessionIds: (
    server: { url: string; username: string | null; password: string | null },
    directory: string,
  ) => Promise<ReadonlySet<string> | null>
  /** tier-2 等 serverReady 的上限(默认 5000ms);超过 = fail-open 跳过存在性校验。 */
  serverWaitMs?: number
  /** tier-2 全部目录查询的总预算(默认 2500ms);超过 = 未回目录 fail-open。 */
  queryBudgetMs?: number
}

export function decodeDirBase64(dirBase64: string): string | null {
  try {
    return Buffer.from(dirBase64, "base64url").toString("utf8")
  } catch {
    return null
  }
}

/**
 * 预清入口:tier-1 同步执行完毕后返回,`done` 在 tier-2(或其 fail-open 超时)后 resolve。
 * `done` **保证 resolve**(全路径 try/catch + 时限)—— store-get gate 等它,绝不悬挂。
 */
export function runTabsPreclean(deps: TabsPrecleanDeps): { done: Promise<void> } {
  const serverWaitMs = deps.serverWaitMs ?? 5000
  const queryBudgetMs = deps.queryBudgetMs ?? 2500

  const writeBack = (result: SanitizeResult | { tabs: unknown[]; drops: PrecleanDrop[] }, reencodeTabs: (v: unknown) => unknown, reencodeRecent: ((v: unknown) => unknown) | null) => {
    for (const d of result.drops) deps.log(`[req014-preclean] dropped (${d.where}): ${d.reason} — ${d.detail}`)
    if ("tabsChanged" in result) {
      if (result.tabsChanged) deps.setValue(TABS_KEY, reencodeTabs(result.tabs))
      if (result.recentChanged && reencodeRecent) deps.setValue(TABS_RECENT_KEY, reencodeRecent(result.recent))
    } else if (result.drops.length > 0) {
      deps.setValue(TABS_KEY, reencodeTabs(result.tabs))
    }
  }

  let tier1Tabs: unknown[] | null = null
  let reencodeTabs: ((v: unknown) => unknown) | null = null

  // tier-1:同步(在 createMainWindow 之前被调用;renderer 尚不存在,写回无竞态)。
  try {
    const rawTabs = deps.getValue(TABS_KEY)
    const rawRecent = deps.getValue(TABS_RECENT_KEY)
    if (rawTabs !== undefined && rawTabs !== null) {
      const decTabs = decodeStoreValue(rawTabs)
      const decRecent = rawRecent !== undefined && rawRecent !== null ? decodeStoreValue(rawRecent) : { value: {}, reencode: (v: unknown) => JSON.stringify(v) }
      if (decTabs) {
        const res = sanitizeTabsValue(decTabs.value, decRecent?.value ?? {})
        if (res) {
          writeBack(res, decTabs.reencode, decRecent?.reencode ?? null)
          tier1Tabs = res.tabs
          reencodeTabs = decTabs.reencode
          if (res.drops.length > 0)
            deps.log(`[req014-preclean] tier-1 done: dropped ${res.drops.length} entr${res.drops.length === 1 ? "y" : "ies"} (formats), ${res.tabs.length} kept`)
        } else {
          deps.log("[req014-preclean] tier-1 fail-open: tabs value not an array — left untouched")
        }
      } else {
        deps.log("[req014-preclean] tier-1 fail-open: tabs value unparseable — left untouched")
      }
    }
  } catch (e) {
    deps.log(`[req014-preclean] tier-1 fail-open on error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // tier-2:异步,时限内 fail-open。无 session tab 或 tier-1 不可读 → 直接完成。
  const done = (async () => {
    try {
      if (!tier1Tabs || !reencodeTabs) return
      const sessionTabs = tier1Tabs.filter((t) => isValidSessionTab(t as AnyTab))
      if (sessionTabs.length === 0) return
      const server = await Promise.race([
        deps.awaitServer().catch(() => null),
        new Promise<null>((r) => setTimeout(r, serverWaitMs, null)),
      ])
      if (!server) {
        deps.log(`[req014-preclean] tier-2 fail-open: server not ready within ${serverWaitMs}ms — existence check skipped`)
        return
      }
      const budget = new Promise<null>((r) => setTimeout(r, queryBudgetMs, null))
      const listSessionIds = async (dirBase64: string): Promise<ReadonlySet<string> | null> => {
        const directory = decodeDirBase64(dirBase64)
        if (!directory) return null
        return Promise.race([deps.fetchSessionIds(server, directory).catch(() => null), budget])
      }
      const res = await dropDanglingSessionTabs(tier1Tabs, listSessionIds)
      if (res.drops.length > 0) {
        writeBack(res, reencodeTabs, null)
        // recent 若指向刚被剔的 tab,一并收敛(重算幸存 key 集)。
        try {
          const rawRecent = deps.getValue(TABS_RECENT_KEY)
          const decRecent = rawRecent !== undefined && rawRecent !== null ? decodeStoreValue(rawRecent) : null
          const key = decRecent && decRecent.value !== null && typeof decRecent.value === "object" ? (decRecent.value as Record<string, unknown>).key : undefined
          if (decRecent && typeof key === "string" && key.length > 0) {
            const known = new Set(res.tabs.map((t) => tabKeyOf(t as AnyTab)).filter((k): k is string => !!k))
            if (!known.has(key)) {
              const next = { ...(decRecent.value as Record<string, unknown>) }
              delete next.key
              deps.setValue(TABS_RECENT_KEY, decRecent.reencode(next))
              deps.log(`[req014-preclean] tier-2: cleared recent key pointing at dropped tab — ${key.slice(0, 200)}`)
            }
          }
        } catch {
          // recent 收敛失败不致命:上游 tabs.tsx:102 会安全清理 mismatch
        }
        deps.log(`[req014-preclean] tier-2 done: dropped ${res.drops.length} dangling session tab(s), ${res.tabs.length} kept`)
      }
    } catch (e) {
      deps.log(`[req014-preclean] tier-2 fail-open on error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()

  return { done }
}
