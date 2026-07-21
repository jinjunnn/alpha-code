// REQ-087 C2:live-engine characterization(Issue alpha-code#181 激活前置)。
// 六项 1:1 落实 req087-characterization.test.ts 底部原 test.todo(该处现以锚点测试
// 指向本文件,防静默漂移)。运行前提与「真引擎」口径见 harness.ts 头注释;
// 入口:bun run --cwd packages/ui-mac test:live:req087(或 scripts/req087-live-characterization.sh)。
//
// characterization 语义:锁定 legacy(冻结 packages/app session 叶 + 真实引擎)的行为面,
// 作为 REQ-088 adapter 模式的对照基线;AC7 的「vs legacy 基线」在 REQ-088 未交付前只有
// legacy 半边 —— 本 suite 负责采集并落盘该基线(baselines/legacy-baseline.json),
// adapter 侧对比在 REQ-088 T4 完成。
//
// REQ-088 T3/T4:同一 suite 经 REQ088_HOST/REQ088_SURFACE 双参数跑 adapter 半边(webhost +
// localStorage 闸,见 harness.ts 头注释)。每个会话页断言点都先过 assertSurfaceMode ——
// 保证「度量的确实是那半边」;webhost 运行落盘 baselines/req088-<flavor>.json 与
// req088-<flavor>-facts.json(孤儿 PTY/订阅数原始值),对比判定见
// docs/audits/2026-07-13-s48-req088-t3t4-live-adapter-comparison.md。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "playwright-core"
import {
  ADAPTER_SEL,
  ENGINE_PORT,
  FLAVOR,
  HOST,
  SEL,
  SURFACE,
  assertSurfaceMode,
  bottomGap,
  domCounts,
  partOffsets,
  startWorld,
  timelineScroller,
  trackOpenEventStreams,
  visiblePartIds,
  waitTimelineStable,
  type LiveWorld,
} from "./harness"

let world: LiveWorld
/** webhost 运行的原始事实(孤儿 PTY/订阅数等),afterAll 落盘供 T4 对比表引用。 */
const runFacts: Record<string, unknown> = {}

beforeAll(async () => {
  world = await startWorld()
}, 240000)

afterAll(async () => {
  if (HOST === "webhost") {
    const dir = join(import.meta.dir, "baselines")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `req088-${FLAVOR}-facts.json`),
      JSON.stringify({ capturedAt: new Date().toISOString(), flavor: FLAVOR, ...runFacts }, null, 2) + "\n",
    )
  }
  await world?.stop()
})

async function openSession(sessionID: string, hash?: string) {
  const { context, page } = await world.newPage()
  await page.goto(world.sessionUrl(sessionID, hash), { waitUntil: "domcontentloaded" })
  await waitTimelineStable(page)
  await assertSurfaceMode(page)
  return { context, page }
}

async function messages(sessionID: string): Promise<any[]> {
  return world.api(`/session/${sessionID}/message?limit=500`)
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20000, label = "condition") {
  const deadline = Date.now() + timeoutMs
  let last: T
  while (Date.now() < deadline) {
    last = await fn()
    if (ok(last)) return last
    await Bun.sleep(150)
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last!)?.slice(0, 300)}`)
}

function composerFocused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el?.closest('[data-alpha-composer="session"], [data-component="prompt-input-v2"]')
  })
}

// ---------------------------------------------------------------------------

describe("REQ-087 C2 live-engine characterization", () => {
  test(
    "AC5 100+ 长 timeline:首屏/stream 更新/上翻历史/跟底与暂停/hash 定位 无跳动不丢锚",
    async () => {
      const session = await world.createSession("AC5 long timeline")
      // 110+ 条真实消息(>100),中段插一条真实文本 prompt 作 hash 深链靶点
      // (hash 定位面向 user 消息;shell 种子的 user 行渲染为零高,不适合做视口断言)
      await world.seedShellTurns(session.id, 20, "ac5a")
      await world.promptText(session.id, "SCRIPT:text:3:10:mid1")
      await world.seedShellTurns(session.id, 34, "ac5b")
      const seeded = await messages(session.id)
      expect(seeded.length).toBeGreaterThanOrEqual(110)

      const { context, page } = await openSession(session.id)
      try {
        // 首屏:单 composer、初始跟底
        const counts = await domCounts(page)
        expect(counts.composersVisible).toBe(1)
        expect(await bottomGap(page)).toBeLessThanOrEqual(2)

        // stream 更新 + 跟底:真实 SSE 流入时保持贴底
        const stream1 = world.promptText(session.id, "SCRIPT:text:12:120:s1").catch(() => null)
        await page.waitForFunction(() => document.body.textContent?.includes("s1-2"), undefined, { timeout: 20000 })
        const gapsDuringStream: number[] = []
        for (let i = 0; i < 5; i++) {
          gapsDuringStream.push(await bottomGap(page))
          await Bun.sleep(150)
        }
        await stream1
        expect(Math.max(...gapsDuringStream)).toBeLessThanOrEqual(24) // 流式增量下允许一帧内的追赶
        await waitTimelineStable(page)
        expect(await bottomGap(page)).toBeLessThanOrEqual(2)

        // 上翻历史:滚到分页边界触发真实 before= 分页,prepend 后可见锚不动。
        // 真实引擎 ~30ms 就返回,锚位捕获会与 prepend 竞态 —— 给 before= 响应加 2s 网络
        // 延迟(纯延迟,数据仍是真引擎的;与上游 smoke 的 messageDelay 同一取证手法),
        // 保证「捕获基准 → 数据落地 → 锚位收敛」三段确定有序。
        let sawBefore = false
        let beforeDone = false
        await page.route("**/message*", async (route) => {
          if (route.request().url().includes("before=")) await new Promise((r) => setTimeout(r, 2000))
          await route.continue()
        })
        page.on("request", (req) => {
          const url = req.url()
          if (url.includes("/message") && url.includes("before=")) sawBefore = true
        })
        page.on("requestfinished", (req) => {
          const url = req.url()
          if (url.includes("/message") && url.includes("before=")) beforeDone = true
        })
        const scroller = timelineScroller(page)
        const box = await scroller.boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
        const deadline = Date.now() + 60000
        while (!sawBefore && Date.now() < deadline) {
          await page.mouse.wheel(0, -400)
          await Bun.sleep(25)
        }
        expect(sawBefore).toBe(true)
        // 锚:抓当前可见 part 的相对位置
        const anchors = (await visiblePartIds(page)).slice(0, 3)
        expect(anchors.length).toBeGreaterThan(0)
        const before = await partOffsets(page, anchors)
        await waitFor(async () => beforeDone, (v) => v, 20000, "history page fetched")
        await waitTimelineStable(page)
        // 与上游 expect.poll(positions).toEqual(before) 同语义:prepend + 行高再测量期间
        // 允许瞬时补偿,断言锚位收敛回原值(±1px 取整容差)
        const anchorsConverged = await waitFor(
          () => partOffsets(page, anchors),
          (after) => anchors.every((key) => Math.abs(after[key]! - before[key]!) <= 1),
          10000,
          "prepend anchors converge",
        )
        expect(anchorsConverged).toBeTruthy()

        // 跟底与暂停:上翻状态下新流不把视口拽回底部
        const topBefore = await page.evaluate(() => {
          const s = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
            el.querySelector("[data-timeline-row]"),
          )!
          return s.scrollTop
        })
        const stream2 = world.promptText(session.id, "SCRIPT:text:8:100:s2").catch(() => null)
        await Bun.sleep(1500)
        const topDuring = await page.evaluate(() => {
          const s = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
            el.querySelector("[data-timeline-row]"),
          )!
          return s.scrollTop
        })
        expect(Math.abs(topDuring - topBefore)).toBeLessThanOrEqual(4) // 跟底已暂停
        await stream2

        // hash 定位:#message-<id> 深链把目标(中段 user 消息)带进视口
        const all = await messages(session.id)
        const target = all.find(
          (m: any) =>
            m.info.role === "user" && m.parts.some((p: any) => p.type === "text" && p.text?.includes(":mid1")),
        )?.info.id as string
        expect(target).toBeTruthy()
        const hashPage = await openSession(session.id, `#message-${target}`)
        try {
          await waitFor(
            () =>
              hashPage.page.evaluate((id) => {
                const el =
                  document.getElementById(`message-${id}`) ?? document.querySelector(`[data-message-id="${id}"]`)
                if (!el) return false
                const r = el.getBoundingClientRect()
                return r.bottom > 0 && r.top < window.innerHeight
              }, target),
            (v) => v === true,
            20000,
            "hash target visible",
          )
        } finally {
          await hashPage.context.close()
        }
      } finally {
        await context.close()
      }
    },
    240000,
  )

  test(
    "AC6 terminal 生命周期:新建/关闭/重排/切 session/重启恢复 + PTY 不泄漏",
    async () => {
      const a = await world.createSession("AC6 terminal A")
      const b = await world.createSession("AC6 terminal B")
      await world.seedShellTurns(a.id, 2, "ac6a")
      await world.seedShellTurns(b.id, 2, "ac6b")
      const ptyBaseline = await world.ptyCount()

      // 新版布局:会话切换入口 = titlebar tabs(与上游 e2e 同通道预置)
      const { context, page } = await world.newPage({ tabSessionIds: [a.id, b.id] })
      await page.goto(world.sessionUrl(a.id), { waitUntil: "domcontentloaded" })
      await waitTimelineStable(page)
      await assertSurfaceMode(page)
      try {
        // 新建:ctrl+` 打开面板即自动建终端(真实 PTY)
        await page.keyboard.press("Control+`")
        await waitFor(
          () => page.evaluate(() => document.querySelector("#terminal-panel")?.getAttribute("aria-hidden")),
          (v) => v === "false",
          20000,
          "terminal panel open",
        )
        await waitFor(() => world.ptyCount(), (n) => n === ptyBaseline + 1, 20000, "pty +1")

        // 再新建一个
        await page.keyboard.press("Control+Alt+t")
        await waitFor(() => world.ptyCount(), (n) => n === ptyBaseline + 2, 20000, "pty +2")
        const tabTitles = () =>
          page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('#terminal-panel [role="tab"]')].map(
              (el) => el.textContent?.trim() ?? "",
            ),
          )
        await waitFor(tabTitles, (t) => t.length === 2, 15000, "2 terminal tabs")
        const orderBefore = await tabTitles()

        // 重排:拖拽第一个 tab 到第二个 tab 之后(solid-dnd 指针路径)
        const tabs = page.locator('#terminal-panel [role="tab"]')
        const b1 = await tabs.nth(0).boundingBox()
        const b2 = await tabs.nth(1).boundingBox()
        expect(b1 && b2).toBeTruthy()
        await page.mouse.move(b1!.x + b1!.width / 2, b1!.y + b1!.height / 2)
        await page.mouse.down()
        await page.mouse.move(b1!.x + b1!.width / 2 + 10, b1!.y + b1!.height / 2, { steps: 4 })
        await page.mouse.move(b2!.x + b2!.width - 4, b2!.y + b2!.height / 2, { steps: 12 })
        await page.mouse.up()
        await Bun.sleep(500)
        const orderAfter = await tabTitles()
        expect(orderAfter.length).toBe(2)
        expect([...orderAfter].sort()).toEqual([...orderBefore].sort())
        expect(orderAfter).toEqual([orderBefore[1], orderBefore[0]]) // 顺序已交换
        expect(await world.ptyCount()).toBe(ptyBaseline + 2) // 重排不动 PTY

        // 切 session:同 workspace 终端随行(tab 集不变、面板不复制)。
        // 已实测的 legacy 行为(characterization 记录,非理想化):首次切走时活动终端的
        // WebSocket 断连会触发一次 recoverTerminal clone —— UI tab 仍是 2,但旧 server PTY
        // 成为孤儿(engine 侧 +1,直到 shell 退出)。断言口径:①不线性累积(反复切换不再
        // 增长);②tab 集恒为 2;③孤儿 ≤1 —— REQ-088 adapter 对照时不得劣于该基线。
        const switchTo = async (id: string) => {
          await page.click(world.titlebarTab(id))
          await waitTimelineStable(page)
          await assertSurfaceMode(page) // adapter:切 session 后外框仍在(路由级重挂语义)
          await Bun.sleep(600)
        }
        await switchTo(b.id)
        expect((await domCounts(page)).terminalPanels).toBe(1)
        await switchTo(a.id)
        const afterFirstRoundTrip = await world.ptyCount()
        expect(afterFirstRoundTrip).toBeLessThanOrEqual(ptyBaseline + 3) // ≤ 2 个真终端 + 1 个恢复孤儿
        // 不线性累积:再来两轮往返,PTY 数不得继续增长
        await switchTo(b.id)
        await switchTo(a.id)
        await switchTo(b.id)
        await switchTo(a.id)
        const afterMoreRoundTrips = await world.ptyCount()
        expect(afterMoreRoundTrips).toBeLessThanOrEqual(afterFirstRoundTrip)
        await waitFor(tabTitles, (t) => t.length === 2, 15000, "tab set stays 2 across switches")
        const recoveryOrphans = Math.max(0, afterMoreRoundTrips - (ptyBaseline + 2))
        runFacts.recoveryOrphanPtys = recoveryOrphans
        console.log(`[AC6][${FLAVOR}] recovery-clone orphan PTYs after switches: ${recoveryOrphans}`)

        // 重启恢复:reload 后恢复既有终端(tab 集不变),不重复 attach、PTY 数不再增长
        await page.reload({ waitUntil: "domcontentloaded" })
        await waitTimelineStable(page)
        await waitFor(tabTitles, (t) => t.length === 2, 30000, "terminal tabs restored after reload")
        await waitFor(
          () => world.ptyCount(),
          (n) => n <= afterMoreRoundTrips,
          20000,
          "pty does not grow after reload (no dup attach)",
        )

        // 关闭:逐个关掉 tab,面板收合;tab 内 PTY 全量回收 —— 泄漏上界 = 已记录的恢复孤儿
        const hiddenAfterReload = await page.evaluate(
          () => document.querySelector("#terminal-panel")?.getAttribute("aria-hidden"),
        )
        if (hiddenAfterReload === "true") {
          await page.keyboard.press("Control+`") // 面板若随会话状态恢复为收合,先展开再关闭(inert 面板不可点)
          await Bun.sleep(600)
        }
        // 逐个触发 tab 的关闭按钮(DOM 派发 click —— 走的仍是 app 真实 onClose →
        // terminal.close → 引擎 DELETE /pty;绕开 reload 后覆盖层对合成指针的拦截)
        for (let i = 0; i < 6; i++) {
          const closed = await page.evaluate(() => {
            const btn = document.querySelector<HTMLButtonElement>(
              '#terminal-panel button[aria-label="Close terminal"]',
            )
            if (!btn) return false
            btn.click()
            return true
          })
          if (!closed) break
          await Bun.sleep(600)
        }
        await waitFor(
          () => page.evaluate(() => document.querySelectorAll('#terminal-panel [role="tab"]').length),
          (n) => n === 0,
          20000,
          "all terminal tabs closed",
        )
        await waitFor(
          () => page.evaluate(() => document.querySelector("#terminal-panel")?.getAttribute("aria-hidden")),
          (v) => v === "true",
          20000,
          "terminal panel collapsed",
        )
        await waitFor(
          () => world.ptyCount(),
          (n) => n <= ptyBaseline + recoveryOrphans,
          20000,
          "tab-listed ptys all reclaimed (leak bounded by recorded recovery orphans)",
        )
        // 测试卫生:清掉孤儿 PTY,并验证引擎 DELETE 能把计数还原到基线
        for (const pty of (await world.api("/pty")) as { id: string }[]) {
          await world.api(`/pty/${pty.id}`, { method: "DELETE" }).catch(() => null)
        }
        await waitFor(() => world.ptyCount(), (n) => n === 0, 15000, "engine pty cleanup")
      } finally {
        await context.close()
      }
    },
    240000,
  )

  test(
    "AC6 permission once/always/reject 与 abort/重试 流程",
    async () => {
      const session = await world.createSession("AC6 permission")
      await world.seedShellTurns(session.id, 1, "ac6p")
      // 会话级规则:bash 一律 ask(真实权限机,不 mock)
      await world.api(`/session/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ permission: [{ permission: "bash", pattern: "*", action: "ask" }] }),
      })

      const { context, page } = await openSession(session.id)
      try {
        const dockButtons = page.locator(`${SEL.permissionActions} button`)
        const askEvent = (from: number) =>
          world.recorder.wait(
            (e) => e.type === "permission.asked" && e.properties?.sessionID === session.id,
            20000,
            from,
          )
        const repliedEvent = (from: number, reply: string) =>
          world.recorder.wait(
            (e) =>
              e.type === "permission.replied" &&
              e.properties?.sessionID === session.id &&
              (e.properties?.response === reply || e.properties?.reply === reply),
            20000,
            from,
          )

        // --- once ---
        let cursor = world.recorder.cursor()
        const p1 = world.promptText(session.id, "SCRIPT:tool-bash:echo perm-once").catch(() => null)
        expect(await askEvent(cursor)).toBeTruthy()
        await dockButtons.last().waitFor({ state: "visible", timeout: 15000 })
        expect(await dockButtons.count()).toBe(3)
        await dockButtons.nth(2).click() // Allow once(primary,最右)
        expect(await repliedEvent(cursor, "once")).toBeTruthy()
        await p1
        const afterOnce = await messages(session.id)
        const toolParts = afterOnce.flatMap((m: any) => m.parts).filter((p: any) => p.type === "tool" && p.tool === "bash")
        expect(toolParts.at(-1)?.state?.status).toBe("completed")

        // --- always ---
        cursor = world.recorder.cursor()
        const p2 = world.promptText(session.id, "SCRIPT:tool-bash:echo perm-always").catch(() => null)
        expect(await askEvent(cursor)).toBeTruthy() // once 不落盘,二次仍询问
        await dockButtons.last().waitFor({ state: "visible", timeout: 15000 })
        await dockButtons.nth(1).click() // Allow always(secondary,中间)
        expect(await repliedEvent(cursor, "always")).toBeTruthy()
        await p2

        // --- always 已生效:同模式命令不再询问,直接执行 ---
        cursor = world.recorder.cursor()
        const p3 = world.promptText(session.id, "SCRIPT:tool-bash:echo perm-auto").catch(() => null)
        await p3
        const asked3 = world.recorder.events
          .slice(cursor)
          .find((e) => e.type === "permission.asked" && e.properties?.sessionID === session.id)
        expect(asked3).toBeUndefined()
        const afterAuto = await messages(session.id)
        const autoTool = afterAuto
          .flatMap((m: any) => m.parts)
          .filter((p: any) => p.type === "tool" && p.tool === "bash")
          .at(-1)
        expect(autoTool?.state?.status).toBe("completed")
        expect(JSON.stringify(autoTool?.state?.input)).toContain("perm-auto")

        // --- reject(不同 pattern,不吃 always 缓存)---
        cursor = world.recorder.cursor()
        const p4 = world.promptText(session.id, "SCRIPT:tool-bash:ls -la").catch(() => null)
        expect(await askEvent(cursor)).toBeTruthy()
        await dockButtons.first().waitFor({ state: "visible", timeout: 15000 })
        await dockButtons.nth(0).click() // Deny
        expect(await repliedEvent(cursor, "reject")).toBeTruthy()
        await p4
        const afterReject = await messages(session.id)
        const rejectedTool = afterReject
          .flatMap((m: any) => m.parts)
          .filter((p: any) => p.type === "tool" && p.tool === "bash")
          .at(-1)
        expect(["error", "denied", "rejected"]).toContain(rejectedTool?.state?.status)

        // --- abort / 重试 ---
        const slow = world.promptText(session.id, "SCRIPT:text:60:250:ab1").catch(() => null)
        await page.waitForFunction(() => document.body.textContent?.includes("ab1-1"), undefined, { timeout: 20000 })
        await world.api(`/session/${session.id}/abort`, { method: "POST", body: JSON.stringify({}) })
        await slow
        const afterAbort = await messages(session.id)
        const abortedInfo = afterAbort.at(-1)?.info
        expect(abortedInfo?.role).toBe("assistant")
        expect(abortedInfo?.time?.completed).toBeTruthy() // abort 收敛,不悬挂
        // 重试:abort 后会话未僵死,新 prompt 正常完成
        const retry = await world.promptText(session.id, "SCRIPT:text:2:10")
        expect(retry?.parts?.some((p: any) => p.type === "text")).toBe(true)
      } finally {
        await context.close()
      }
    },
    240000,
  )

  test(
    "AC4(运行时半边)event subscription 数与 PTY 数跨切换不线性累积(探针只覆盖 DOM/命令面)",
    async () => {
      const a = await world.createSession("AC4 switch A")
      const b = await world.createSession("AC4 switch B")
      await world.seedShellTurns(a.id, 3, "ac4a")
      await world.seedShellTurns(b.id, 3, "ac4b")

      const { context, page } = await world.newPage({ tabSessionIds: [a.id, b.id] })
      const sse = trackOpenEventStreams(page, ENGINE_PORT)
      try {
        await page.goto(world.sessionUrl(a.id), { waitUntil: "domcontentloaded" })
        await waitTimelineStable(page)
        await assertSurfaceMode(page)
        await Bun.sleep(1000)
        const sseBaseline = sse.open
        const ptyBaseline = await world.ptyCount()
        expect(sseBaseline).toBeGreaterThanOrEqual(1) // 常驻订阅存在(ServerSync)

        const samples: { open: number; pty: number; composers: number; panels: number }[] = []
        for (let i = 0; i < 8; i++) {
          const target = i % 2 === 0 ? b.id : a.id
          await page.click(world.titlebarTab(target))
          await waitTimelineStable(page)
          await Bun.sleep(300)
          const counts = await domCounts(page)
          samples.push({ open: sse.open, pty: await world.ptyCount(), composers: counts.composersVisible, panels: counts.terminalPanels })
        }
        for (const s of samples) {
          expect(s.composers).toBeLessThanOrEqual(1)
          expect(s.panels).toBeLessThanOrEqual(1)
          expect(s.pty).toBe(ptyBaseline) // 切换不产生 PTY
        }
        const finalOpen = samples.at(-1)!.open
        runFacts.ac4 = { sseBaseline, samples }
        expect(finalOpen).toBeLessThanOrEqual(sseBaseline) // 订阅数不随切换线性增长
        expect(Math.max(...samples.map((s) => s.open))).toBeLessThanOrEqual(sseBaseline + 1) // 切换瞬间允许一条过渡流
      } finally {
        await context.close()
      }
    },
    240000,
  )

  test(
    "AC7 mount time / 订阅数 / 内存趋势 / 长 timeline 滚动 vs legacy 基线",
    async () => {
      // legacy 基线采集(REQ-088 未交付,本测试产出对照基线本体;adapter 对比= REQ-088 T4)
      const session = await world.createSession("AC7 perf baseline")
      await world.seedShellTurns(session.id, 55, "ac7")

      const mounts: number[] = []
      let subscriptions = 0
      const heap: number[] = []
      let scrollFrames: number[] = []

      for (let run = 0; run < 3; run++) {
        const { context, page } = await world.newPage()
        const sse = trackOpenEventStreams(page, ENGINE_PORT)
        try {
          const t0 = Date.now()
          await page.goto(world.sessionUrl(session.id), { waitUntil: "domcontentloaded" })
          await page.waitForSelector(SEL.timelineRow, { timeout: 45000, state: "attached" })
          mounts.push(Date.now() - t0)
          await waitTimelineStable(page)
          await assertSurfaceMode(page) // 度量点之后:确认这一跑真的是期望半边
          await Bun.sleep(500)
          subscriptions = sse.open

          if (run === 0) {
            // 内存趋势:稳定后 3 个采样点
            for (let i = 0; i < 3; i++) {
              heap.push(
                await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0),
              )
              await Bun.sleep(1200)
            }
            // 长 timeline 滚动:rAF 帧间隔分布
            const scroller = timelineScroller(page)
            const box = await scroller.boundingBox()
            await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
            await page.evaluate(() => {
              const w = window as any
              w.__req087Frames = []
              let last = performance.now()
              const tick = (now: number) => {
                w.__req087Frames.push(now - last)
                last = now
                if (w.__req087Frames.length < 600) requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })
            for (let i = 0; i < 25; i++) {
              await page.mouse.wheel(0, -400)
              await Bun.sleep(30)
            }
            for (let i = 0; i < 25; i++) {
              await page.mouse.wheel(0, 400)
              await Bun.sleep(30)
            }
            scrollFrames = await page.evaluate(() => (window as any).__req087Frames as number[])
          }
        } finally {
          await context.close()
        }
      }

      const sorted = [...scrollFrames].sort((x, y) => x - y)
      const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
      const baseline = {
        capturedAt: new Date().toISOString(),
        mode:
          HOST === "frozen"
            ? "legacy (frozen packages/app leaf, real engine, vite dev, headless Chrome)"
            : `${SURFACE} (REQ-088 webhost comparison entry, real engine, vite dev, headless Chrome)`,
        engine: "bun run packages/opencode/src/index.ts serve",
        sessionMessages: 110,
        mountMs: { runs: mounts, median: [...mounts].sort((x, y) => x - y)[1] },
        openEventSubscriptions: subscriptions,
        usedJSHeapBytes: { samples: heap, delta: heap.length ? heap[heap.length - 1] - heap[0] : 0 },
        scrollFrameMs: {
          frames: scrollFrames.length,
          avg: scrollFrames.reduce((a, v) => a + v, 0) / Math.max(1, scrollFrames.length),
          p95: pct(95),
          max: sorted.at(-1) ?? 0,
        },
        adapterComparison:
          HOST === "frozen"
            ? "PENDING REQ-088 T4 — adapter mode does not exist yet; this file IS the legacy baseline"
            : "REQ-088 T3/T4 dual-run — judgement in docs/audits/2026-07-13-s48-req088-t3t4-live-adapter-comparison.md",
      }
      const dir = join(import.meta.dir, "baselines")
      mkdirSync(dir, { recursive: true })
      const baselineFile = HOST === "frozen" ? "legacy-baseline.json" : `req088-${FLAVOR}.json`
      writeFileSync(join(dir, baselineFile), JSON.stringify(baseline, null, 2) + "\n")
      console.log(`[AC7][${FLAVOR}] baseline:`, JSON.stringify(baseline))

      expect(mounts.length).toBe(3)
      expect(Math.min(...mounts)).toBeGreaterThan(0)
      expect(Math.max(...mounts)).toBeLessThan(30000)
      expect(subscriptions).toBeGreaterThanOrEqual(1)
      expect(heap.every((v) => v > 0)).toBe(true)
      expect(scrollFrames.length).toBeGreaterThan(50)
    },
    300000,
  )

  test(
    "streaming / steer / queue / abort / tool card / file-review panel 焦点返回 characterization",
    async () => {
      const session = await world.createSession("AC focus return")
      await world.seedShellTurns(session.id, 2, "acf")

      const { context, page } = await openSession(session.id)
      try {
        const composer = page.getByRole("textbox", { name: /Ask anything/i }).first()
        await composer.click()
        expect(await composerFocused(page)).toBe(true)

        // streaming:composer 发送后焦点不丢
        await composer.fill("SCRIPT:text:25:200:f1")
        await page.keyboard.press("Enter")
        await page.waitForFunction(() => document.body.textContent?.includes("f1-0"), undefined, { timeout: 20000 })
        expect(await composerFocused(page)).toBe(true)

        // steer/queue:流式中继续输入并回车 → 排队 followup,焦点仍在 composer
        await composer.fill("SCRIPT:text:2:10:f2")
        await page.keyboard.press("Enter")
        expect(await composerFocused(page)).toBe(true)
        // 两条 prompt 回复最终都完成(队列被消费,真实引擎侧证据):
        // seed 2 shell 回复 + 流式回复 f1 + 排队回复 f2 = 4 条 completed assistant
        await waitFor(
          async () => {
            const all = await messages(session.id)
            return all.filter((m: any) => m.info.role === "assistant" && m.info.time?.completed).length
          },
          (n) => n >= 4,
          60000,
          "queued prompts drained",
        )
        await waitFor(
          async () => JSON.stringify(await messages(session.id)),
          (s) => s.includes("f2-0"),
          20000,
          "queued reply landed",
        )

        // abort:流式中 Escape 中断(composer 空时 Esc = stop),焦点留在 composer
        const abortStart = Date.now()
        await composer.fill("SCRIPT:text:60:250:f3")
        await page.keyboard.press("Enter")
        await page.waitForFunction(() => document.body.textContent?.includes("f3-1"), undefined, { timeout: 20000 })
        await page.keyboard.press("Escape")
        await waitFor(
          async () => {
            const all = await messages(session.id)
            const last = all.at(-1)
            return last?.info?.role === "assistant" && !!last?.info?.time?.completed
          },
          (v) => v === true,
          30000,
          "stream aborted via Escape",
        )
        // 真中断证据:完成远早于 60×250ms 的自然时长,且尾 token 未出现
        expect(Date.now() - abortStart).toBeLessThan(12000)
        expect(JSON.stringify(await messages(session.id))).not.toContain("f3-59")
        expect(await composerFocused(page)).toBe(true)

        // tool card:点开一条 Shell 工具卡(焦点离开 composer),ctrl+l 命令把焦点还回 composer
        const toolRow = page.locator(SEL.partRow).filter({ hasText: "Shell" }).first()
        await toolRow.click()
        expect(await composerFocused(page)).toBe(false)
        await page.keyboard.press("Control+l")
        await waitFor(() => composerFocused(page), (v) => v === true, 10000, "focus back after tool card (ctrl+l)")

        // file-review panel:mod+shift+r 翻转开合(新版布局默认展开 review 侧栏,
        // characterization 记录的是「toggle 生效 + 关闭后焦点可回 composer」)
        const reviewWidth = () =>
          page.evaluate(() => {
            const el = document.querySelector<HTMLElement>("#review-panel")
            return el ? Math.round(el.getBoundingClientRect().width) : 0
          })
        const initialWidth = await reviewWidth()
        await page.keyboard.press("Meta+Shift+r")
        await waitFor(
          () => reviewWidth(),
          (w) => (initialWidth > 0 ? w === 0 : w > 0),
          15000,
          "review panel toggled",
        )
        await page.keyboard.press("Meta+Shift+r")
        await waitFor(
          () => reviewWidth(),
          (w) => (initialWidth > 0 ? w > 0 : w === 0),
          15000,
          "review panel toggled back",
        )
        await page.keyboard.press("Control+l")
        await waitFor(() => composerFocused(page), (v) => v === true, 10000, "focus back after review panel")
      } finally {
        await context.close()
      }
    },
    240000,
  )

  // T2 §4 注意点 2 的 live 补测(adapter 专属):CrossServerGuard 有界识别引擎 control-plane
  // 「Session not found: <id>」错误族(C4 S5 跨 server 点击与「本 server 不存在的会话 id」同一
  // 抛错路径)→ 渲染引导卡,不落 SurfaceBoundary 致命 fallback。非该族错误的 rethrow 链路无法
  // 经合法通道在真叶上诱发(不 mock 冻结叶),维持 C4 真机实证 + 单测覆盖(证据档 OPEN 项)。
  test.if(SURFACE === "adapter")(
    "CrossServerGuard:会话缺失错误族渲染引导卡而非 SurfaceBoundary fallback",
    async () => {
      const { context, page } = await world.newPage()
      try {
        await page.goto(world.sessionUrl("ses_req088_missing_0000"), { waitUntil: "domcontentloaded" })
        await page.waitForSelector(ADAPTER_SEL.guard, { timeout: 30000 })
        // SurfaceBoundary fallback 未出现(错误没有升级为 surface 致命)
        expect(await page.evaluate(() => document.querySelectorAll("[data-alpha-surface-error]").length)).toBe(0)
        // 引导卡两个动作在位(重新加载 / 返回首页)
        const buttons = await page.evaluate(() =>
          [...document.querySelectorAll("[data-alpha-session-workspace-guard] button")].map(
            (el) => el.textContent?.trim() ?? "",
          ),
        )
        expect(buttons.length).toBe(2)
        runFacts.crossServerGuard = { buttons }
      } finally {
        await context.close()
      }
    },
    120000,
  )
})
