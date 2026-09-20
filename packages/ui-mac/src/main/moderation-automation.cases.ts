// REQ-160 AC2(`#1353`)—— 自动化那两个发送入口的判据。
//
// 已批稿 `docs/design/2026-09-19-req160-send-blocked-notice/design.md` §3「自动化」一行:
// **定时任务命中时不产生任何界面元素** —— 那一刻没有人在屏幕前。它按既有失败形态落进那次运行的
// `status.json`,摘要用与界面上同一句人话。
//
// 这里走的是**生产** `runAutomationNow` → `executeTask`,词表也是**真的** `createModerationKeywordStore`
// (由一个假 fetch 喂一条真响应);假的只有引擎 SDK 与落盘。判据是「引擎那一侧一次都没被调用」
// 而不是某个标志位 —— 后者在把检查接到 `session.create` **之后**时照样绿,而那会留下一串空会话。
//
// mock.module 是进程级的,会污染同进程其它测试文件 ⇒ 由 moderation-automation.test.ts 起子进程跑。

import { expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import { join } from "node:path"
import type { AutomationTask } from "../shared/automation-types"

const ROOT = fs.mkdtempSync(join(os.tmpdir(), "alpha-1353-"))
const PROJECT = fs.mkdtempSync(join(os.tmpdir(), "alpha-1353-project-"))

/** 引擎侧被调用过什么。断言的核心是它**空着**。 */
const engine: { created: unknown[]; prompted: unknown[] } = { created: [], prompted: [] }
/** 落盘的 run 文件:`status.json` 的内容就是本票在自动化侧的用户可观察面。 */
const runFiles: Array<{ runId: string; files: Record<string, string> }> = []

mock.module("electron", () => ({
  app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    show() {}
  },
  powerMonitor: { on: () => {} },
}))
mock.module("./logging", () => ({ getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }) }))
mock.module("./alpha-installs", () => ({ alphaGlobalRoot: () => ROOT }))
mock.module("./alpha-user-workspace", () => ({ saveVisibleOutputs: () => {} }))
mock.module("./alpha-workdir", () => ({
  writeRunFiles: (_dir: string, runId: string, files: Record<string, string>) => {
    runFiles.push({ runId, files })
    return { ok: true as const, dir: join(ROOT, "runs", runId) }
  },
}))
mock.module("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: () => ({
    session: {
      create: async (args: unknown) => {
        engine.created.push(args)
        return { data: { id: `sess-${engine.created.length}` } }
      },
      prompt: async (args: unknown) => {
        engine.prompted.push(args)
        return { data: { parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({}),
    },
  }),
}))

const { initModerationKeywords, resetModerationKeywordsForTests, MODERATION_BLOCKED_REASON } = await import(
  "./moderation-keywords"
)
const { saveAutomation, getAutomation } = await import("./alpha-automations")
const { startAutomationScheduler, runAutomationNow } = await import("./automation-scheduler")
const { initAutomationLlm, llmParseAutomation } = await import("./automation-llm")

startAutomationScheduler({
  awaitServer: async () => ({ url: "http://127.0.0.1:1/", username: null, password: null }),
})

/** 真词表 store,由一个假 fetch 喂一条真形状的响应 —— 匹配语义走生产的 shared/moderation-keywords。 */
async function armKeywords(...words: string[]) {
  resetModerationKeywordsForTests()
  const store = initModerationKeywords({
    webBase: () => "https://web.invalid",
    token: () => "tok",
    fetch: (async () =>
      new Response(JSON.stringify({ keywords: words.map((keyword) => ({ category_code: "prohibited_gambling", keyword })) }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"v1"' },
      })) as unknown as typeof fetch,
  })
  expect(await store.refresh()).toBe("updated")
}

function makeTask(id: string, prompt: string): AutomationTask {
  return {
    id,
    name: "每日巡检",
    nlText: prompt,
    schedule: { kind: "interval", everyMinutes: 60 },
    target: { projectDir: PROJECT, agent: "alpha-automation" },
    prompt,
    execution: "local",
    permissionProfile: "readonly",
    budget: { maxDurationMin: 5 },
    overlapPolicy: "skip",
    catchUpPolicy: "skip",
    notify: { system: false },
    enabled: false,
    createdAt: new Date().toISOString(),
  }
}

test("定时任务命中:不建会话、不发 prompt,失败摘要落进那次运行的 status.json", async () => {
  await armKeywords("赌博")
  engine.created.length = 0
  engine.prompted.length = 0
  runFiles.length = 0

  expect(saveAutomation(makeTask("blocked-1", "去找几个赌博网站的资料")).ok).toBe(true)
  expect(await runAutomationNow("blocked-1")).toEqual({ ok: true })

  // ① 引擎那一侧一次都没被碰 —— 而且检查在 `session.create` **之前**,所以连空会话都不留。
  expect(engine.created).toEqual([])
  expect(engine.prompted).toEqual([])

  // ② 界面上什么都不产生(这一刻没人在看),结论只落在那次运行的记录里。
  const status = runFiles.find((entry) => entry.files["status.json"])
  expect(status).toBeDefined()
  const parsed = JSON.parse(status!.files["status.json"]!) as { status: string; error: string }
  expect(parsed.status).toBe("failed")
  expect(parsed.error).toContain(MODERATION_BLOCKED_REASON)
  // 与界面上同一个说法;不写「违规」「禁止」这类给人定性的词(已批稿 §4)。
  expect(parsed.error).not.toContain("违规")
  expect(parsed.error).not.toContain("禁止")

  // ③ 历史里也是这一句人话,不是一个错误码。
  const record = getAutomation("blocked-1")?.lastRun
  expect(record?.status).toBe("failed")
  expect(record?.summary).toContain(MODERATION_BLOCKED_REASON)
})

test("反向:未命中的定时任务照常建会话、照常发 prompt", async () => {
  await armKeywords("赌博")
  engine.created.length = 0
  engine.prompted.length = 0
  runFiles.length = 0

  expect(saveAutomation(makeTask("clean-1", "每天把测试跑一遍并写个小结")).ok).toBe(true)
  expect(await runAutomationNow("clean-1")).toEqual({ ok: true })

  expect(engine.created).toHaveLength(1)
  expect(engine.prompted).toHaveLength(1)
  expect(getAutomation("clean-1")?.lastRun?.status).toBe("ok")
})

test("词表读不到时不拦 —— 定时任务照跑(没做过的检查不摆出一个做过的样子)", async () => {
  resetModerationKeywordsForTests()
  engine.created.length = 0
  engine.prompted.length = 0

  expect(saveAutomation(makeTask("nolist-1", "去找几个赌博网站的资料")).ok).toBe(true)
  expect(await runAutomationNow("nolist-1")).toEqual({ ok: true })
  expect(engine.prompted).toHaveLength(1)
})

test("一句话解析:命中即不发给模型,用这条路径既有的失败形态回话(不新增界面)", async () => {
  await armKeywords("赌博")
  engine.created.length = 0
  engine.prompted.length = 0
  initAutomationLlm({ awaitServer: async () => ({ url: "http://127.0.0.1:1/", username: null, password: null }) })

  expect(await llmParseAutomation("每天提醒我去赌博", PROJECT)).toEqual({
    ok: false,
    reason: MODERATION_BLOCKED_REASON,
  })
  expect(engine.created).toEqual([])
  expect(engine.prompted).toEqual([])
})

test("一句话解析反向:未命中照常走到模型那一步", async () => {
  await armKeywords("赌博")
  engine.created.length = 0
  engine.prompted.length = 0
  initAutomationLlm({ awaitServer: async () => ({ url: "http://127.0.0.1:1/", username: null, password: null }) })

  await llmParseAutomation("每天九点提醒我写日报", PROJECT)
  expect(engine.created).toHaveLength(1)
  expect(engine.prompted).toHaveLength(1)
})
