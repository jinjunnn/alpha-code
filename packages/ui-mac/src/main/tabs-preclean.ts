// REQ-014:冷启动「Not found / 整屏 ErrorPage」毒键预清(方案②,S17 实证「删毒键即愈」)。
// 上游 tabs.tsx 在 renderer 侧恢复 `opencode.global.dat` 的 `tabs` 路由,alpha 无恢复层可插
// (方案① renderer 守卫已被 S17 证伪:整屏态 alpha 子组件全不挂)。修 = main 预清,两级:
//   tier-1 格式级(同步):剔除**可证坏**条目 —— 非对象、session 缺 server/sessionId、draft 缺 draftID;
//   tier-2 存在性(serverReady 后,时限内 fail-open):tab 指向已删会话 → 上游 Not found 白屏(形态 A)。
// renderer 首读经 store-get gate(ipc.ts)等预清完成 —— A1 window-first 不回退:窗口/splash/侧栏照常
// 先开,只有 tabs 恢复数据最多晚几秒(时限硬界)。
//
// 契约锚(#926 起与上游**类型**绑死,不再手抄字段清单):
//   store = "opencode.global.dat",键 "tabs" / "tabs.recent"(app/src/utils/persist.ts GLOBAL_STORAGE;
//   ui-mac desktop 无 windowID ⇒ Persist.window 经 resolveTarget 落 GLOBAL_STORAGE);
//   tab 形状 = 下方 SessionTabContract / DraftTabContract,与 packages/app(滚动 pin,ADR-034)的
//   Tab 类型做双向键集相等断言 —— pin bump 改了 tab 形状而这里没跟,ui-mac typecheck **当场红**。
// 历史(#926 的教训,两处同因):
//   ① dirBase64 曾是 session tab 字段(REQ-014 形态 B 毒键即「缺 dirBase64 → tabHref /undefined/... →
//     titlebar throw」)。上游后来删掉该字段并改用 sessionHref(server, sessionId),旧判据
//     「缺 dirBase64 = 可证坏」正好命中现行合法形状 ⇒ 今天写的 session tab 下次开机被当毒键清掉。
//   ② tabKeyOf 手抄上游 tabKey 文法做 recent 收敛 —— 上游 key 格式同样漂了(现行
//     `${server}\n/server/${base64url(server)}/session/${id}`),重算恒 mismatch ⇒ 合法 recent 被清。
//     上游 tabs.tsx 本就对 mismatch 的 recent key 自愈(ready 后 setRecentKey(undefined),非崩溃向),
//     预清不再替上游解释 key 格式:**tabs.recent 一律不读不写**(手写别人文法的替身,整块删除)。
// 纪律:一切拿不准 = fail-open 保持原样(绝不越修越坏);每次剔除留痕(B11 反静默)。
// 纯逻辑与编排分离:本文件不 import electron(上游仅 import type,运行时零依赖),全部依赖注入 → 可单测。

// ── #926 漂移闸:tier-1 的形状判据与上游 Tab 类型绑死(typecheck 层,运行时零成本)──────────
// packages/app 走滚动 pin(ADR-034):上游改 tab 形状 ⇒ 键集相等断言当场红,逼着本文件的判据同步走,
// 而不是像 dirBase64 那样悄悄漂成「专剔合法数据」。断言本体在 renderer 侧的
// `src/renderer/tabs-preclean-contract.ts`(与上游类型的比对必须 import "@opencode-ai/app",而该
// import 在 src/main 会抢先装载上游 app.d.ts 的 `Window.api` 极简全局声明、压过 env.d.ts 的
// ElectronAPI —— skipLibCheck 吞掉声明处冲突,379 条使用点假红;renderer 侧与现状同序,无此问题)。

/** tier-1 要求的 session tab 形状(= 现行上游 SessionTab;字段级校验见 isValidSessionTab)。 */
export type SessionTabContract = { type: "session"; server: string; sessionId: string }
/** 现行上游 DraftTab 形状(tier-1 只要求 draftID,见 isValidDraftTab;其余键仅作漂移绊线)。 */
export type DraftTabContract = { type: "draft"; draftID: string; server: string; directory: string; worktree?: string }

export type PrecleanDrop = { where: "tabs"; reason: string; detail: string }

const SESSION_ID = /^[A-Za-z0-9_-]+$/

type AnyTab = Record<string, unknown>

// 多余键(如旧 build 写的 dirBase64)不剔:上游按需取字段,多余键无害;剔了才是丢用户数据。
function isValidSessionTab(t: AnyTab): boolean {
  return (
    t.type === "session" &&
    typeof t.server === "string" &&
    t.server.length > 0 &&
    !t.server.includes("\n") &&
    typeof t.sessionId === "string" &&
    SESSION_ID.test(t.sessionId)
  )
}

function isValidDraftTab(t: AnyTab): boolean {
  return t.type === "draft" && typeof t.draftID === "string" && (t.draftID as string).length > 0
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
  /** tabs 数组是否有改动(须写回);false = 一个字节都不动。 */
  tabsChanged: boolean
  drops: PrecleanDrop[]
}

/**
 * tier-1 格式级清洗(纯函数)。剔除**可证坏**的条目:非对象、session 缺 server/sessionId、
 * draft 缺 draftID;未知 type 的对象条目 fail-open 保留(绝不替未来格式做决定)。
 * tabs.recent 不在此处理(#926 起预清一律不动它;上游 tabs.tsx 对 mismatch 自愈)。
 */
export function sanitizeTabsValue(tabsValue: unknown): SanitizeResult | null {
  if (!Array.isArray(tabsValue)) return null // tabs 整体不可读 → fail-open,一律不动
  const drops: PrecleanDrop[] = []
  const kept: unknown[] = []
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
          reason: "malformed session tab (missing/invalid server|sessionId — cannot form a route)",
          detail: JSON.stringify(t).slice(0, 200),
        })
      continue
    }
    if (t.type === "draft") {
      if (isValidDraftTab(t)) kept.push(t)
      else drops.push({ where: "tabs", reason: "malformed draft tab (missing draftID)", detail: JSON.stringify(t).slice(0, 200) })
      continue
    }
    kept.push(t) // 未知类型:fail-open 保留
  }
  return { tabs: kept, tabsChanged: kept.length !== tabsValue.length, drops }
}

/**
 * tier-2 存在性过滤(纯逻辑,查询注入)。checkSession 按 id 直查(`GET /api/session/{id}`,S21 真机
 * 实测契约:200=存活 / 404+SessionNotFoundError=悬空):true=存活留,false=悬空剔,null=不确定
 * (网络错/超时/非典型响应)→ fail-open 保留并计数(留痕,B11 反静默)。只动合法 session tab。
 * (原设计按目录 session.list 判集合,真机实测 limit 不生效、每页仅 2 条 → cursor.next 恒在 →
 * 「分页未尽 fail-open」使 tier-2 恒空转;S21 走查当场发现并改按 id 直查。)
 */
export async function dropDanglingSessionTabs(
  tabs: unknown[],
  checkSession: (sessionId: string) => Promise<boolean | null>,
): Promise<{ tabs: unknown[]; drops: PrecleanDrop[]; uncertain: number }> {
  const ids = new Map<string, boolean | null>()
  for (const t of tabs) {
    const tab = t as AnyTab
    if (isValidSessionTab(tab) && !ids.has(tab.sessionId as string)) ids.set(tab.sessionId as string, null)
  }
  await Promise.all(
    [...ids.keys()].map(async (sid) => {
      try {
        ids.set(sid, await checkSession(sid))
      } catch {
        ids.set(sid, null)
      }
    }),
  )
  const drops: PrecleanDrop[] = []
  let uncertain = 0
  const kept = tabs.filter((t) => {
    const tab = t as AnyTab
    if (!isValidSessionTab(tab)) return true
    const alive = ids.get(tab.sessionId as string)
    if (alive === true) return true
    if (alive === null || alive === undefined) {
      uncertain++
      return true // 不确定 → fail-open
    }
    drops.push({
      where: "tabs",
      reason: "dangling session tab (session no longer exists — REQ-014 形态 A)",
      detail: JSON.stringify({ server: tab.server, sessionId: tab.sessionId }),
    })
    return false
  })
  return { tabs: kept, drops, uncertain }
}

// ---------- 编排(依赖注入;index.ts 接线真实 store/logger/SDK) ----------

export const GLOBAL_RENDERER_STORE = "opencode.global.dat"
export const TABS_KEY = "tabs"
export const TABS_RECENT_KEY = "tabs.recent"
// #564:catalog-liveness 看门狗解析首屏目录用(上游 tabs.tsx 的 Persist.window("tabs.info"),
// ui-mac 无 windowID ⇒ 落 GLOBAL_STORAGE)。preclean 自身不读它,放这里只为契约键单一来源。
export const TABS_INFO_KEY = "tabs.info"

export type TabsPrecleanDeps = {
  getValue: (key: string) => unknown
  setValue: (key: string, value: unknown) => void
  log: (line: string) => void
  /** serverReady 的 promise 化;调用方不 race,超时由本模块统一管。 */
  awaitServer: () => Promise<{ url: string; username: string | null; password: string | null } | null>
  /** 按 id 查会话存在:true=存活 / false=悬空 / null=不确定 → fail-open。 */
  checkSession: (
    server: { url: string; username: string | null; password: string | null },
    sessionId: string,
  ) => Promise<boolean | null>
  /** tier-2 等 serverReady 的上限(默认 5000ms);超过 = fail-open 跳过存在性校验。 */
  serverWaitMs?: number
  /** tier-2 全部存在性查询的总预算(默认 2500ms);超过 = 未回项 fail-open。 */
  queryBudgetMs?: number
}

/**
 * 预清入口:tier-1 同步执行完毕后返回,`done` 在 tier-2(或其 fail-open 超时)后 resolve。
 * `done` **保证 resolve**(全路径 try/catch + 时限)—— store-get gate 等它,绝不悬挂。
 * 只写 `tabs`;`tabs.recent` 一律不动(#926,上游自愈 mismatch)。
 */
export function runTabsPreclean(deps: TabsPrecleanDeps): { done: Promise<void> } {
  const serverWaitMs = deps.serverWaitMs ?? 5000
  const queryBudgetMs = deps.queryBudgetMs ?? 2500

  const logDrops = (drops: PrecleanDrop[]) => {
    for (const d of drops) deps.log(`[req014-preclean] dropped (${d.where}): ${d.reason} — ${d.detail}`)
  }

  let tier1Tabs: unknown[] | null = null
  let reencodeTabs: ((v: unknown) => unknown) | null = null

  // tier-1:同步(在 createMainWindow 之前被调用;renderer 尚不存在,写回无竞态)。
  try {
    const rawTabs = deps.getValue(TABS_KEY)
    if (rawTabs !== undefined && rawTabs !== null) {
      const decTabs = decodeStoreValue(rawTabs)
      if (decTabs) {
        const res = sanitizeTabsValue(decTabs.value)
        if (res) {
          logDrops(res.drops)
          if (res.tabsChanged) deps.setValue(TABS_KEY, decTabs.reencode(res.tabs))
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
      const checkSession = async (sessionId: string): Promise<boolean | null> =>
        Promise.race([deps.checkSession(server, sessionId).catch(() => null), budget])
      const res = await dropDanglingSessionTabs(tier1Tabs, checkSession)
      if (res.uncertain > 0)
        deps.log(`[req014-preclean] tier-2 fail-open: ${res.uncertain} session tab(s) unverifiable (query error/timeout) — kept as-is`)
      if (res.drops.length > 0) {
        logDrops(res.drops)
        deps.setValue(TABS_KEY, reencodeTabs(res.tabs))
        // tabs.recent 不收敛:若它指向刚被剔的 tab,上游 tabs.tsx ready 后自清(mismatch 非崩溃向)。
        deps.log(`[req014-preclean] tier-2 done: dropped ${res.drops.length} dangling session tab(s), ${res.tabs.length} kept`)
      }
    } catch (e) {
      deps.log(`[req014-preclean] tier-2 fail-open on error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()

  return { done }
}
