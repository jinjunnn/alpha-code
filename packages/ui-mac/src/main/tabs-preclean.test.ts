import { describe, expect, test } from "bun:test"
import {
  decodeStoreValue,
  dropDanglingSessionTabs,
  runTabsPreclean,
  sanitizeTabsValue,
  TABS_KEY,
  TABS_RECENT_KEY,
} from "./tabs-preclean"

// #926 勘破锚:以下形状全部取自**盘上实读字节**(2026-08-11,本机两份
// `~/Library/Application Support/ai.opencode.desktop{,.dev}/opencode.global.dat`)与上游构造点
// (packages/app/src/context/tabs.tsx addSessionTab/promoteDraft:`{ type:"session", server, sessionId }`)。
// 判据纪律:锚是独立字面量,不 import 被测对象或上游的常量;同一判据的多条用例用不同字面量。

// 现行形状 session tab(今天 renderer 写的就是这三个键,无 dirBase64)
const SESSION_A = { type: "session", server: "sidecar", sessionId: "ses_0c55bc852ffekEbmWhJQ824HJ4" }
const SESSION_B = { type: "session", server: "wsl:ubuntu", sessionId: "ses_0be83b52cffeLQrUz2wzXJ5D6x" }
const SESSION_C = { type: "session", server: "ssh:devbox", sessionId: "ses_0bb1ed87bffeKk7DccY3nJzGIC" }
// 旧 build 写的形状(带 dirBase64,本机盘上实存 7 条):多余键,上游按需取字段 → 必须存活
const LEGACY_SESSION = {
  type: "session",
  server: "sidecar",
  dirBase64: "L1VzZXJzL3RpZGUvRG9jdW1lbnRzL3dvcmtzcGFjZQ",
  sessionId: "ses_0badd9c7affemUPdVWc18Z8EKA",
}
// 现行形状 draft tab(盘上实存 36+328 条)
const DRAFT_A = { type: "draft", draftID: "3c87eebf-f534-4fc7-b775-b76f98b1b18c", server: "sidecar", directory: "/Users/tide/app/alpha-code" }
const DRAFT_B = { type: "draft", draftID: "fb6ead90-e1b2-41d5-9129-2a8c0a6aa6ce", server: "sidecar", directory: "/tmp/x", worktree: "/tmp/x/wt" }
// 现行 recent key(盘上 tabs.info 键逐字同格式:`${server}\n/server/${base64url(server)}/session/${id}`)
const RECENT_CURRENT = { key: "sidecar\n/server/c2lkZWNhcg/session/ses_0c55bc852ffekEbmWhJQ824HJ4" }

function makeStore(init: Record<string, unknown>) {
  const data = { ...init }
  const logs: string[] = []
  const writes: string[] = []
  return {
    data,
    logs,
    writes,
    deps: {
      getValue: (k: string) => data[k],
      setValue: (k: string, v: unknown) => {
        writes.push(k)
        data[k] = v
      },
      log: (l: string) => logs.push(l),
    },
  }
}

const ALL_ALIVE = {
  awaitServer: async () => ({ url: "http://127.0.0.1:1", username: null, password: null }),
  checkSession: async () => true as boolean | null,
  serverWaitMs: 200,
  queryBudgetMs: 200,
}

describe("#926 用户可观察主判据:开着 N 个 tab → 重启预清 → N 个都还在", () => {
  test("4 个现行/历史形状 tab(2 session + legacy + draft)全存活,盘上零改写,recent 原样", async () => {
    const before = JSON.stringify([SESSION_A, SESSION_B, LEGACY_SESSION, DRAFT_A])
    const recentBefore = JSON.stringify(RECENT_CURRENT)
    const s = makeStore({ [TABS_KEY]: before, [TABS_RECENT_KEY]: recentBefore })
    const { done } = runTabsPreclean({ ...s.deps, ...ALL_ALIVE })
    await done
    // 用户重启后读到的 tabs = 预清后的 store(ipc.ts store-get gate 语义):一个不少、顺序不变
    expect(s.data[TABS_KEY]).toBe(before)
    expect(JSON.parse(s.data[TABS_KEY] as string)).toHaveLength(4)
    // 最后活跃 tab 指针不被动(现行 key 格式不再被当「旧格式」剔)
    expect(s.data[TABS_RECENT_KEY]).toBe(recentBefore)
    // 零写盘:不是「写回了相同内容」,是根本没写(幂等重写盲区)
    expect(s.writes).toEqual([])
  })

  test("6 个 tab(3 session + 2 draft + 未知未来类型)全存活,draft 形态的 recent 原样", async () => {
    const future = { type: "workspace-tab-v3", payload: { x: 1 } }
    const before = JSON.stringify([SESSION_C, SESSION_B, SESSION_A, DRAFT_B, DRAFT_A, future])
    const recentBefore = JSON.stringify({ key: "draft:fb6ead90-e1b2-41d5-9129-2a8c0a6aa6ce" })
    const s = makeStore({ [TABS_KEY]: before, [TABS_RECENT_KEY]: recentBefore })
    const { done } = runTabsPreclean({ ...s.deps, ...ALL_ALIVE })
    await done
    expect(s.data[TABS_KEY]).toBe(before)
    expect(JSON.parse(s.data[TABS_KEY] as string)).toHaveLength(6)
    expect(s.data[TABS_RECENT_KEY]).toBe(recentBefore)
    expect(s.writes).toEqual([])
  })

  test("单个现行形状 session tab 也存活(退化到 N=1 仍成立)", async () => {
    const solo = { type: "session", server: "sidecar", sessionId: "ses_0ba9d5115ffeQQcvghXsx1FgGc" }
    const before = JSON.stringify([solo])
    const s = makeStore({ [TABS_KEY]: before })
    const { done } = runTabsPreclean({ ...s.deps, ...ALL_ALIVE })
    await done
    expect(s.data[TABS_KEY]).toBe(before)
    expect(s.writes).toEqual([])
  })
})

describe("sanitizeTabsValue(tier-1 格式级):真坏的仍然剔,好的一个不碰", () => {
  test("现行形状与 legacy(带 dirBase64)混排:零剔除零改动", () => {
    const res = sanitizeTabsValue([SESSION_A, LEGACY_SESSION, DRAFT_A, DRAFT_B])!
    expect(res.tabs).toEqual([SESSION_A, LEGACY_SESSION, DRAFT_A, DRAFT_B])
    expect(res.tabsChanged).toBe(false)
    expect(res.drops).toEqual([])
  })

  test("session 缺 sessionId → 剔(唯一还能证坏的缺键形态)", () => {
    const noId = { type: "session", server: "sidecar" }
    const res = sanitizeTabsValue([noId, SESSION_B])!
    expect(res.tabs).toEqual([SESSION_B])
    expect(res.tabsChanged).toBe(true)
    expect(res.drops).toHaveLength(1)
  })

  test("server 含换行(会撕裂上游 tabKey)→ 剔;sessionId 带路径穿越字符 → 剔", () => {
    const evilServer = { type: "session", server: "side\ncar", sessionId: "ses_0bab3d5afffesERNg5Wm2Dglhn" }
    const evilId = { type: "session", server: "sidecar", sessionId: "../../etc/passwd" }
    const res = sanitizeTabsValue([evilServer, evilId, SESSION_C])!
    expect(res.tabs).toEqual([SESSION_C])
    expect(res.drops).toHaveLength(2)
  })

  test("非对象条目被剔;draft 缺 draftID 被剔;未知 type 保留(fail-open)", () => {
    const badDraft = { type: "draft", server: "sidecar", directory: "/y" }
    const unknownTab = { type: "future-thing", payload: 1 }
    const res = sanitizeTabsValue([null, 42, badDraft, unknownTab, DRAFT_A])!
    expect(res.tabs).toEqual([unknownTab, DRAFT_A])
    expect(res.drops).toHaveLength(3)
  })

  test("tabs 整体不是数组 → null(fail-open 一律不动)", () => {
    expect(sanitizeTabsValue("garbage")).toBeNull()
    expect(sanitizeTabsValue({ not: "array" })).toBeNull()
  })
})

describe("#926 tabs.recent 一律不动(上游 tabs.tsx 对 mismatch 自愈,预清不再解释 key 格式)", () => {
  test("recent 指向早已不存在的 tab(任意格式)→ 预清照样不写它", async () => {
    const staleRecent = JSON.stringify({ key: "sidecar\n/L3RtcC9nb25l/session/ses_gone0000000000000000000000" })
    const s = makeStore({
      [TABS_KEY]: JSON.stringify([SESSION_A]),
      [TABS_RECENT_KEY]: staleRecent,
    })
    const { done } = runTabsPreclean({ ...s.deps, ...ALL_ALIVE })
    await done
    expect(s.data[TABS_RECENT_KEY]).toBe(staleRecent)
    expect(s.writes).toEqual([])
  })

  test("tier-1/tier-2 都发生剔除时也只写 tabs,不写 recent", async () => {
    const noServer = { type: "session", sessionId: "ses_0baa7458bfferaCjttZxZGRMBa" }
    const dangling = { type: "session", server: "sidecar", sessionId: "ses_deleted00000000000000000000" }
    const recentBefore = JSON.stringify(RECENT_CURRENT)
    const s = makeStore({
      [TABS_KEY]: JSON.stringify([SESSION_A, noServer, dangling]),
      [TABS_RECENT_KEY]: recentBefore,
    })
    const { done } = runTabsPreclean({
      ...s.deps,
      ...ALL_ALIVE,
      checkSession: async (_srv, sid) => sid === SESSION_A.sessionId,
    })
    await done
    expect(JSON.parse(s.data[TABS_KEY] as string)).toEqual([SESSION_A])
    expect(s.data[TABS_RECENT_KEY]).toBe(recentBefore)
    expect(s.writes).toEqual([TABS_KEY, TABS_KEY]) // tier-1 一次 + tier-2 一次
  })
})

describe("dropDanglingSessionTabs(tier-2 存在性,按 id 直查)", () => {
  test("悬空 session 被剔(形态 A),存活者/legacy/draft 不动", async () => {
    const dangling = { type: "session", server: "sidecar", sessionId: "ses_deleted00000000000000000000" }
    const res = await dropDanglingSessionTabs([SESSION_A, dangling, LEGACY_SESSION, DRAFT_A], async (sid) => sid !== dangling.sessionId)
    expect(res.tabs).toEqual([SESSION_A, LEGACY_SESSION, DRAFT_A])
    expect(res.drops).toHaveLength(1)
    expect(res.uncertain).toBe(0)
  })

  test("查询返回 null(网络错/超时/非典型响应)→ fail-open 保留并计数", async () => {
    const res = await dropDanglingSessionTabs([SESSION_A, SESSION_B], async () => null)
    expect(res.tabs).toEqual([SESSION_A, SESSION_B])
    expect(res.drops).toEqual([])
    expect(res.uncertain).toBe(2)
  })

  test("查询抛错 → fail-open 全保留", async () => {
    const res = await dropDanglingSessionTabs([SESSION_C], async () => {
      throw new Error("boom")
    })
    expect(res.tabs).toEqual([SESSION_C])
    expect(res.uncertain).toBe(1)
  })

  test("同 id 多 tab 只查一次,判定一致", async () => {
    let calls = 0
    const dup = { ...SESSION_B }
    const res = await dropDanglingSessionTabs([SESSION_B, dup], async () => {
      calls++
      return false
    })
    expect(calls).toBe(1)
    expect(res.tabs).toEqual([])
    expect(res.drops).toHaveLength(2)
  })
})

describe("decodeStoreValue", () => {
  test("JSON 字符串双向;裸对象直通;垃圾 → null", () => {
    const dec = decodeStoreValue(JSON.stringify([SESSION_A]))!
    expect(dec.value).toEqual([SESSION_A])
    expect(dec.reencode(dec.value)).toBe(JSON.stringify([SESSION_A]))
    const raw = decodeStoreValue([SESSION_A])!
    expect(raw.reencode(raw.value)).toEqual([SESSION_A])
    expect(decodeStoreValue("not-json{")).toBeNull()
    expect(decodeStoreValue(42)).toBeNull()
  })
})

describe("runTabsPreclean(编排)", () => {
  test("server 不 ready(超时)→ tier-2 fail-open,tier-1 结果保留", async () => {
    const dangling = { type: "session", server: "sidecar", sessionId: "ses_deleted00000000000000000000" }
    const noServer = { type: "session", sessionId: "ses_0d95ffb7fffedPfx3LVPg2xCYQ" }
    const s = makeStore({ [TABS_KEY]: JSON.stringify([dangling, noServer]) })
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: () => new Promise(() => {}), // 永不 resolve
      checkSession: async () => false,
      serverWaitMs: 50,
      queryBudgetMs: 50,
    })
    await done
    // tier-1 剔了缺 server 的;tier-2 超时 → 悬空(格式合法)保留
    expect(JSON.parse(s.data[TABS_KEY] as string)).toEqual([dangling])
    expect(s.logs.some((l) => l.includes("tier-2 fail-open"))).toBe(true)
  })

  test("空 store → 快速完成零写", async () => {
    const s = makeStore({})
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: async () => null,
      checkSession: async () => null,
      serverWaitMs: 10,
      queryBudgetMs: 10,
    })
    await done
    expect(Object.keys(s.data)).toEqual([])
    expect(s.writes).toEqual([])
  })

  test("剔除必留痕(B11 反静默):每条 drop 都有日志行", async () => {
    const noId = { type: "session", server: "sidecar" }
    const s = makeStore({ [TABS_KEY]: JSON.stringify([noId, SESSION_A]) })
    const { done } = runTabsPreclean({ ...s.deps, ...ALL_ALIVE })
    await done
    expect(s.logs.some((l) => l.includes("dropped (tabs)") && l.includes("malformed session tab"))).toBe(true)
    expect(s.logs.some((l) => l.includes("tier-1 done"))).toBe(true)
  })
})
