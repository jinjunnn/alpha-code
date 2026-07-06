import { describe, expect, test } from "bun:test"
import {
  decodeDirBase64,
  decodeStoreValue,
  dropDanglingSessionTabs,
  runTabsPreclean,
  sanitizeTabsValue,
  tabKeyOf,
  TABS_KEY,
  TABS_RECENT_KEY,
} from "./tabs-preclean"

// REQ-014 预清:样本取自 S17 证据原件形状(audits/2026-07-05-s17-t4-c28/req014-poisoned-tabs-evidence.json)。
const GOOD_SESSION = {
  type: "session",
  server: "sidecar",
  dirBase64: "L1VzZXJzL3RpZGUvYXBwL2thbWEtYm90LWxvY2Fs",
  sessionId: "ses_12bdd430cffeTa9NAoIXeDEXS4",
}
const GOOD_DRAFT = { type: "draft", draftID: "110926dc-a521-4161-a6ba-519db7970068", server: "sidecar", directory: "/x" }
// 形态 B 毒键:旧版序列化的 session tab,缺 dirBase64 → 上游 tabHref 生成 /undefined/... → titlebar 整屏崩
const POISON_SESSION = { type: "session", server: "sidecar", sessionId: "ses_0d95ffb7fffedPfx3LVPg2xCYQ" }
// 旧格式 recent key(S17 证据逐字):带 /server/ 段,不可能与任何重算 tabKey 相等
const POISON_RECENT = { key: "sidecar\n/server/c2lkZWNhcg/session/ses_0d95ffb7fffedPfx3LVPg2xCYQ" }
// worktree "/" 全局约定(ADR-008):dirBase64="Lw"(base64url of "/")是合法键,shape-only 校验必须放行
const ROOT_WORKTREE_SESSION = { type: "session", server: "sidecar", dirBase64: "Lw", sessionId: "ses_root000000000000000000000" }

describe("sanitizeTabsValue(tier-1 格式级)", () => {
  test("S17 证据形状:缺 dirBase64 的 session 被剔,合法 session/draft 存活,旧格式 recent 被清", () => {
    const res = sanitizeTabsValue([GOOD_SESSION, GOOD_DRAFT, POISON_SESSION], { ...POISON_RECENT })!
    expect(res.tabs).toEqual([GOOD_SESSION, GOOD_DRAFT])
    expect(res.tabsChanged).toBe(true)
    expect(res.recent.key).toBeUndefined()
    expect(res.recentChanged).toBe(true)
    expect(res.drops.length).toBe(2)
  })

  test("worktree \"/\"(dirBase64=Lw)存活 —— 绝不按解码值剔", () => {
    const recent = { key: tabKeyOf(ROOT_WORKTREE_SESSION)! }
    const res = sanitizeTabsValue([ROOT_WORKTREE_SESSION], recent)!
    expect(res.tabs).toEqual([ROOT_WORKTREE_SESSION])
    expect(res.tabsChanged).toBe(false)
    expect(res.recentChanged).toBe(false)
  })

  test("合法态零改动(recent 指向幸存 tab)", () => {
    const recent = { key: tabKeyOf(GOOD_SESSION)! }
    const res = sanitizeTabsValue([GOOD_SESSION, GOOD_DRAFT], recent)!
    expect(res.tabsChanged).toBe(false)
    expect(res.recentChanged).toBe(false)
    expect(res.drops).toEqual([])
  })

  test("draft:key 形态的 recent 指向幸存 draft → 保留", () => {
    const res = sanitizeTabsValue([GOOD_DRAFT], { key: `draft:${GOOD_DRAFT.draftID}` })!
    expect(res.recentChanged).toBe(false)
  })

  test("非对象条目被剔;未知 type fail-open 保留且抑制 recent 清理", () => {
    const unknownTab = { type: "future-thing", payload: 1 }
    const res = sanitizeTabsValue([null, GOOD_SESSION, unknownTab], { key: "sidecar\n/whatever/session/x" })!
    expect(res.tabs).toEqual([GOOD_SESSION, unknownTab])
    // 存在未知型 tab → recent key 无法穷尽重算 → fail-open 不清
    expect(res.recentChanged).toBe(false)
  })

  test("tabs 整体不是数组 → null(fail-open 一律不动)", () => {
    expect(sanitizeTabsValue("garbage", {})).toBeNull()
    expect(sanitizeTabsValue({ not: "array" }, {})).toBeNull()
  })

  test("dirBase64 含非法字符(非 URL-safe base64)的 session 被剔", () => {
    const bad = { ...GOOD_SESSION, dirBase64: "has/slash+plus=" }
    const res = sanitizeTabsValue([bad], {})!
    expect(res.tabs).toEqual([])
  })
})

describe("dropDanglingSessionTabs(tier-2 存在性)", () => {
  const ids = (...xs: string[]) => new Set(xs) as ReadonlySet<string>

  test("悬空 session 被剔(形态 A),存活者与 draft 不动", async () => {
    const dangling = { ...GOOD_SESSION, sessionId: "ses_deleted00000000000000000000" }
    const res = await dropDanglingSessionTabs([GOOD_SESSION, dangling, GOOD_DRAFT], async () => ids(GOOD_SESSION.sessionId))
    expect(res.tabs).toEqual([GOOD_SESSION, GOOD_DRAFT])
    expect(res.drops.length).toBe(1)
  })

  test("查询返回 null(失败/分页未尽)→ 该目录 fail-open 全保留", async () => {
    const dangling = { ...GOOD_SESSION, sessionId: "ses_deleted00000000000000000000" }
    const res = await dropDanglingSessionTabs([GOOD_SESSION, dangling], async () => null)
    expect(res.tabs).toEqual([GOOD_SESSION, dangling])
    expect(res.drops).toEqual([])
  })

  test("查询抛错 → fail-open 全保留", async () => {
    const res = await dropDanglingSessionTabs([GOOD_SESSION], async () => {
      throw new Error("boom")
    })
    expect(res.tabs).toEqual([GOOD_SESSION])
  })
})

describe("decodeStoreValue / decodeDirBase64", () => {
  test("JSON 字符串双向;裸对象直通;垃圾 → null", () => {
    const dec = decodeStoreValue(JSON.stringify([GOOD_SESSION]))!
    expect(dec.value).toEqual([GOOD_SESSION])
    expect(dec.reencode(dec.value)).toBe(JSON.stringify([GOOD_SESSION]))
    const raw = decodeStoreValue([GOOD_SESSION])!
    expect(raw.reencode(raw.value)).toEqual([GOOD_SESSION])
    expect(decodeStoreValue("not-json{")).toBeNull()
    expect(decodeStoreValue(42)).toBeNull()
  })

  test("decodeDirBase64:URL-safe 解码;Lw → /", () => {
    expect(decodeDirBase64("Lw")).toBe("/")
    expect(decodeDirBase64("L1VzZXJzL3RpZGUvYXBwL2thbWEtYm90LWxvY2Fs")).toBe("/Users/tide/app/kama-bot-local")
  })
})

describe("runTabsPreclean(编排)", () => {
  function makeStore(init: Record<string, unknown>) {
    const data = { ...init }
    const logs: string[] = []
    return {
      data,
      logs,
      deps: {
        getValue: (k: string) => data[k],
        setValue: (k: string, v: unknown) => {
          data[k] = v
        },
        log: (l: string) => logs.push(l),
      },
    }
  }

  test("端到端:tier-1 剔格式毒 + tier-2 剔悬空,均写回并留痕;done 必 resolve", async () => {
    const dangling = { ...GOOD_SESSION, sessionId: "ses_deleted00000000000000000000" }
    const s = makeStore({
      [TABS_KEY]: JSON.stringify([GOOD_SESSION, POISON_SESSION, dangling]),
      [TABS_RECENT_KEY]: JSON.stringify(POISON_RECENT),
    })
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: async () => ({ url: "http://127.0.0.1:1", username: null, password: null }),
      fetchSessionIds: async () => new Set([GOOD_SESSION.sessionId]),
      serverWaitMs: 200,
      queryBudgetMs: 200,
    })
    await done
    expect(JSON.parse(s.data[TABS_KEY] as string)).toEqual([GOOD_SESSION])
    expect(JSON.parse(s.data[TABS_RECENT_KEY] as string)).toEqual({})
    expect(s.logs.some((l) => l.includes("形态 B") || l.includes("legacy serialization"))).toBe(true)
    expect(s.logs.some((l) => l.includes("dangling"))).toBe(true)
  })

  test("server 不 ready(超时)→ tier-2 fail-open,tier-1 结果保留", async () => {
    const dangling = { ...GOOD_SESSION, sessionId: "ses_deleted00000000000000000000" }
    const s = makeStore({ [TABS_KEY]: JSON.stringify([dangling, POISON_SESSION]) })
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: () => new Promise(() => {}), // 永不 resolve
      fetchSessionIds: async () => new Set(),
      serverWaitMs: 50,
      queryBudgetMs: 50,
    })
    await done
    // tier-1 剔了格式毒;tier-2 超时 → 悬空(格式合法)保留
    expect(JSON.parse(s.data[TABS_KEY] as string)).toEqual([dangling])
    expect(s.logs.some((l) => l.includes("tier-2 fail-open"))).toBe(true)
  })

  test("空 store / 无 session tab → 快速完成零写", async () => {
    const s = makeStore({})
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: async () => null,
      fetchSessionIds: async () => null,
      serverWaitMs: 10,
      queryBudgetMs: 10,
    })
    await done
    expect(Object.keys(s.data)).toEqual([])
  })

  test("recent 在 tier-2 后指向被剔 tab → 联动清", async () => {
    const dangling = { ...GOOD_SESSION, sessionId: "ses_deleted00000000000000000000" }
    const s = makeStore({
      [TABS_KEY]: JSON.stringify([GOOD_SESSION, dangling]),
      [TABS_RECENT_KEY]: JSON.stringify({ key: tabKeyOf(dangling)! }),
    })
    const { done } = runTabsPreclean({
      ...s.deps,
      awaitServer: async () => ({ url: "http://127.0.0.1:1", username: null, password: null }),
      fetchSessionIds: async () => new Set([GOOD_SESSION.sessionId]),
      serverWaitMs: 200,
      queryBudgetMs: 200,
    })
    await done
    expect(JSON.parse(s.data[TABS_KEY] as string)).toEqual([GOOD_SESSION])
    expect(JSON.parse(s.data[TABS_RECENT_KEY] as string)).toEqual({})
  })
})
