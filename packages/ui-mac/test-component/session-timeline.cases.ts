// REQ-125 C5 — 时间线视图真实 Solid 挂载(happy-dom)。
// Markdown 引擎(@opencode-ai/session-ui/markdown)带 Vite `?worker&url` 依赖,bun 无法装载,
// 在此 mock 成透传 text 的 stub —— 引擎本体的 sanitize/Shiki 契约不在本 suite 复测
// (那是上游包与静态断言的领域),本 suite 只验行 → DOM 的组合正确性。
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

// Major-1 契约的可控 IntersectionObserver:autoVisible=true 时 observe 即视为进窗
// (等价于「行初始就在视口内」),Major-1 用例改为手动 trigger 驱动进窗/出窗。
class IntersectionObserverStub {
  static autoVisible = true
  static instances: IntersectionObserverStub[] = []
  callback: (entries: { target: Element; isIntersecting: boolean }[], observer: IntersectionObserverStub) => void
  constructor(callback: IntersectionObserverStub["callback"]) {
    this.callback = callback
    IntersectionObserverStub.instances.push(this)
  }
  observe(el: Element) {
    if (IntersectionObserverStub.autoVisible) this.callback([{ target: el, isIntersecting: true }], this)
  }
  unobserve() {}
  disconnect() {}
  trigger(el: Element, isIntersecting: boolean) {
    this.callback([{ target: el, isIntersecting }], this)
  }
}
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IntersectionObserverStub

// Major-3 契约的可控 ResizeObserver:手动 trigger 模拟「内容高度变化」事件
// (settling 的驱动源);从不自动触发,既有用例不受影响。
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    ResizeObserverStub.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger() {
    this.callback()
  }
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub

function rectOf(top: number, height: number) {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

// Major-2 契约的引擎侧计数器:count = 引擎收到的(text/streaming)更新次数。
const engineRuns = { count: 0, lastStreaming: undefined as boolean | undefined }

mock.module("@opencode-ai/session-ui/markdown", () => ({
  Markdown: (props: { text?: string; streaming?: boolean; class?: string }) => {
    const el = document.createElement("div")
    el.setAttribute("data-md-stub", "")
    if (props.class) el.className = props.class
    solid.createRenderEffect(() => {
      engineRuns.count += 1
      engineRuns.lastStreaming = props.streaming
      el.textContent = props.text ?? ""
    })
    return el
  },
}))

Bun.plugin({
  name: "session-timeline-component-test",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const runtime = await import("../src/renderer/alpha-ui/session-timeline/session-timeline-test-runtime")
const model = await import("../src/renderer/alpha-ui/session-timeline/timeline-model")

const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetTimelineHarness()
  IntersectionObserverStub.autoVisible = true
  engineRuns.count = 0
  engineRuns.lastStreaming = undefined
  document.body.replaceChildren()
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionTimelineHarness(), host))
  return host
}

type Fixture = Parameters<typeof model.projectTimelineRows>[0]

function conversationRows(status = "idle") {
  const fixture: Fixture = {
    messages: [
      {
        id: "msg_u1",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1000 },
        agent: "build",
        model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
      },
      {
        id: "msg_a1",
        sessionID: "ses_1",
        role: "assistant",
        time: status === "busy" ? { created: 10 } : { created: 10, completed: 20 },
        parentID: "msg_u1",
        modelID: "deepseek-reasoner",
        providerID: "deepseek",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        id: "msg_u2",
        sessionID: "ses_1",
        role: "user",
        time: { created: 2000 },
        agent: "build",
        model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
      },
    ],
    partsOf: (messageID: string) =>
      ({
        msg_u1: [
          { id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "对照 README.md 改一版" },
          {
            id: "prt_f1",
            sessionID: "ses_1",
            messageID: "msg_u1",
            type: "file",
            mime: "image/png",
            filename: "截图.png",
            url: "data:image/png;base64,eA==",
          },
          {
            id: "prt_f2",
            sessionID: "ses_1",
            messageID: "msg_u1",
            type: "file",
            mime: "text/plain",
            filename: "README.md",
            url: "file:///tmp/README.md",
            source: { type: "file", path: "README.md", text: { value: "README.md", start: 3, end: 12 } },
          },
          {
            id: "prt_c1",
            sessionID: "ses_1",
            messageID: "msg_u1",
            type: "text",
            text: "note",
            synthetic: true,
            metadata: {
              opencodeComment: {
                path: "button.css",
                comment: "焦点环别再隐藏",
                selection: { startLine: 42, endLine: 42 },
              },
            },
          },
        ],
        msg_a1: [
          {
            id: "prt_r1",
            sessionID: "ses_1",
            messageID: "msg_a1",
            type: "reasoning",
            text: "先列目录看结构",
            time: status === "busy" ? { start: 0 } : { start: 0, end: 6000 },
          },
          {
            id: "prt_o1",
            sessionID: "ses_1",
            messageID: "msg_a1",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: { status: "running", input: {}, title: "bash", time: { start: 0 } },
          },
          { id: "prt_t1", sessionID: "ses_1", messageID: "msg_a1", type: "text", text: "**发现**:结构完好" },
        ],
        msg_u2: [{ id: "prt_u2", sessionID: "ses_1", messageID: "msg_u2", type: "text", text: "继续" }],
      })[messageID] ?? [],
    status,
  }
  return model.projectTimelineRows(fixture)
}

describe("REQ-125 C5 会话内空态", () => {
  test("就绪且零行 → 渲染空态(会话名 + 引导),容器仍是可滚动 log", async () => {
    const host = mount()
    await flush()

    const empty = host.querySelector("[data-alpha-timeline-empty]")
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain("整理架构说明")
    expect(empty!.textContent).toContain("在下方输入框说点什么")
    expect(host.querySelector("[role='log']")).not.toBeNull()
    expect(host.querySelectorAll("[data-alpha-timeline-row]")).toHaveLength(0)
  })

  test("未就绪(首次同步中)不渲染空态", async () => {
    const host = mount()
    runtime.setTimelineReady(false)
    await flush()

    expect(host.querySelector("[data-alpha-timeline-empty]")).toBeNull()
  })

  test("有行时空态消失", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    await flush()

    expect(host.querySelector("[data-alpha-timeline-empty]")).toBeNull()
  })
})

describe("REQ-125 C5 行 → DOM:文本类组件", () => {
  test("完整回合:用户气泡(提及/附件卡/评论卡)+ 推理块 + Markdown 引擎行 + 工具占位行 + 回合分隔", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    await flush()

    const kinds = [...host.querySelectorAll("[data-alpha-timeline-row]")].map((el) =>
      el.getAttribute("data-alpha-timeline-row"),
    )
    expect(kinds).toEqual(["user", "reasoning", "tool", "markdown", "footnote", "turn", "user"])

    const bubble = host.querySelector(".a-tl-bubble")!
    expect(bubble.textContent).toContain("对照 README.md 改一版")
    expect(bubble.querySelector("[data-mention='file']")?.textContent).toBe("README.md")

    const attach = host.querySelector(".a-tl-attach")!
    expect(attach.textContent).toContain("截图.png")
    expect(attach.getAttribute("data-media")).toBe("image")

    const comment = host.querySelector(".a-tl-comment")!
    expect(comment.textContent).toContain("button.css")
    expect(comment.textContent).toContain("第 42 行")
    expect(comment.textContent).toContain("焦点环别再隐藏")

    const markdown = host.querySelector("[data-alpha-timeline-row='markdown'] [data-md-stub]")!
    expect(markdown.textContent).toBe("**发现**:结构完好")

    const toolCard = host.querySelector("[data-alpha-timeline-row='tool']")!
    expect(toolCard.getAttribute("data-tool")).toBe("bash")
    expect(toolCard.getAttribute("data-status")).toBe("running")
    expect(toolCard.textContent).toContain("运行中")

    expect(host.querySelector("[data-alpha-timeline-row='turn']")!.textContent).toContain("新一轮")
  })

  test("推理块默认折叠,点击展开正文并回写 aria-expanded", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    await flush()

    const head = host.querySelector<HTMLButtonElement>(".a-tl-reason-head")!
    expect(head.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector(".a-tl-reason-body")).toBeNull()

    head.click()
    await flush()
    expect(head.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector(".a-tl-reason-body")!.textContent).toContain("先列目录看结构")
  })

  test("流式回合:末段 Markdown 带光标,推理块进行中标记,busy 空输出显示思考中", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows("busy"))
    await flush()

    expect(host.querySelector("[data-alpha-timeline-row='markdown'][data-streaming='true']")).not.toBeNull()
    expect(host.querySelector(".a-tl-cursor")).not.toBeNull()
    expect(host.querySelector(".a-tl-reason[data-streaming='true']")).not.toBeNull()

    runtime.setTimelineRows(
      model.projectTimelineRows({
        messages: [
          {
            id: "msg_u9",
            sessionID: "ses_1",
            role: "user",
            time: { created: 1000 },
            agent: "build",
            model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
          },
        ],
        partsOf: () => [{ id: "prt_u9", sessionID: "ses_1", messageID: "msg_u9", type: "text", text: "开始" }],
        status: "busy",
      }),
    )
    await flush()
    expect(host.querySelector("[data-alpha-timeline-row='thinking']")).not.toBeNull()
    expect(host.querySelector(".a-tl-cursor")).toBeNull()
  })
})

describe("REQ-125 C5 历史分页驻点", () => {
  test("history.more 显示加载入口,点击触发 onLoadOlder;loading 切换为进行中文案", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    runtime.setTimelineHistory({ more: true, loading: false })
    await flush()

    const button = host.querySelector<HTMLButtonElement>(".a-tl-history-button")!
    button.click()
    await flush()
    expect(runtime.getLoadOlderCalls()).toBe(1)

    runtime.setTimelineHistory({ more: true, loading: true })
    await flush()
    expect(host.querySelector(".a-tl-history-button")).toBeNull()
    expect(host.querySelector("[data-alpha-timeline-history]")!.getAttribute("data-loading")).toBe("true")
  })

  test("没有更早分页时不渲染历史驻点", async () => {
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    await flush()

    expect(host.querySelector("[data-alpha-timeline-history]")).toBeNull()
  })
})

describe("REQ-125 C5 Major-3:连续锚定(settling)", () => {
  /** 装配一条带锚行的时间线,并给滚动容器/锚行装可控几何(scrollTop 与 rect 联动)。 */
  async function mountAnchored(options?: { pendingLoad?: boolean; settleTimeoutMs?: number }) {
    if (options?.pendingLoad) runtime.setLoadOlderPending(true)
    if (options?.settleTimeoutMs !== undefined) runtime.setSettleTimeout(options.settleTimeoutMs)
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    runtime.setTimelineHistory({ more: true, loading: false })
    await flush()

    // 先吃掉挂载期(ready/epoch effect)调度的 scrollToEnd 帧,避免它在测试中途落地清零 scrollTop。
    await new Promise((resolve) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve(0)) : setTimeout(resolve, 0),
    )

    const scrollEl = host.querySelector(".a-tl-scroll") as HTMLElement
    const anchorRow = host.querySelector("[data-alpha-timeline-row]") as HTMLElement
    const geometry = { rowBase: 10 }
    scrollEl.getBoundingClientRect = () => rectOf(0, 600)
    anchorRow.getBoundingClientRect = () => rectOf(geometry.rowBase - scrollEl.scrollTop, 20)

    // 触发历史加载:settling 从 prepend 开始锁锚(视口偏移 = 10);随后关掉 more,
    // 防止 settling 期间的滚动事件再次触发加载。
    ;(host.querySelector(".a-tl-history-button") as HTMLButtonElement).click()
    runtime.setTimelineHistory({ more: false, loading: false })
    await flush()

    const ro = ResizeObserverStub.instances.at(-1)!
    return { host, scrollEl, anchorRow, geometry, ro }
  }

  test("① 锚上方 deferred 行在补偿后长高 → 连续复位,视口内容不位移", async () => {
    const { scrollEl, anchorRow, geometry, ro } = await mountAnchored()

    // prepend 落地:锚行被新内容推下 100 → 复位 +100。
    geometry.rowBase = 110
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(100)

    // 一次性补偿之后:锚上方 deferred Markdown 行进窗挂引擎又长高 50 ——
    // 复审 NOT-FIXED 的根因场景,连续锚定必须继续复位。
    geometry.rowBase = 160
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(150)
    // 视口内容不位移:锚的视口偏移始终回到锁定值 10。
    expect(anchorRow.getBoundingClientRect().top).toBe(10)

    // 稳定后不再位移。
    ro.trigger()
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(150)
  })

  test("② 加载期间用户滚动 → 重捕获新锚继续 settling,不拉拽用户", async () => {
    const { scrollEl, anchorRow, geometry, ro } = await mountAnchored()

    geometry.rowBase = 110
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(100)

    // 用户主动滚动到新位置:锚重捕获(首个可见行,偏移 110-40=70),不是放弃。
    scrollEl.scrollTop = 40
    scrollEl.dispatchEvent(new Event("scroll"))
    await flush()

    // 锚上方又长高 30(deferred 行进窗)→ 相对新锚继续复位,用户位置保持。
    geometry.rowBase = 140
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(70)
    expect(anchorRow.getBoundingClientRect().top).toBe(70)
  })

  test("④ 同 epoch 加载挂起超过时限 → settling 被超时终结,无残留复位", async () => {
    // timer 在 settling 进入那一刻无条件建立:load 永挂起也必须到点终结。
    const { scrollEl, geometry, ro } = await mountAnchored({ pendingLoad: true, settleTimeoutMs: 200 })

    // 时限内:settling 正常复位(prepend 落地推锚 +100)。
    geometry.rowBase = 110
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(100)

    // 超过时限(load 仍挂起):settling 被终结。
    await new Promise((resolve) => setTimeout(resolve, 250))

    // 终结后:再有高度变化不产生任何残留复位(follow 也被挂起的 in-flight 正确闸住)。
    geometry.rowBase = 160
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(100)

    // 滞后放行挂起的 load:settling 已亡,load 收尾路径不得再触碰视口。
    runtime.resolvePendingLoads()
    await flush()
    expect(scrollEl.scrollTop).toBe(100)
  })

  test("③ A 会话加载挂起时,B 会话的贴底跟随不被阻塞(I8 epoch 分片)", async () => {
    runtime.setLoadOlderPending(true)
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    runtime.setTimelineHistory({ more: true, loading: false })
    await flush()

    const scrollEl = host.querySelector(".a-tl-scroll") as HTMLElement
    ;(host.querySelector(".a-tl-history-button") as HTMLButtonElement).click()
    await flush()
    expect(runtime.getLoadOlderCalls()).toBe(1)

    // 切到 B 会话(A 的加载仍挂起 in-flight)。
    runtime.setTimelineEpoch("sidecar /tmp/workspace ses_other")
    runtime.setTimelineHistory({ more: false, loading: false })
    await flush()

    // B 内容增长 → 贴底跟随必须工作(busy 按当前 epoch 判定,A 不阻塞 B)。
    Object.defineProperty(scrollEl, "scrollHeight", { value: 500, configurable: true })
    const ro = ResizeObserverStub.instances.at(-1)!
    ro.trigger()
    expect(scrollEl.scrollTop).toBe(500)

    // 放行 A 的滞后完成:不得触碰 B 的视口。
    runtime.resolvePendingLoads()
    await flush()
    expect(scrollEl.scrollTop).toBe(500)
  })
})

describe("REQ-125 C5 Major-1:Markdown 引擎窗口化", () => {
  function twoMarkdownRows() {
    return model.projectTimelineRows({
      messages: [
        {
          id: "msg_u1",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
        },
        {
          id: "msg_a1",
          sessionID: "ses_1",
          role: "assistant",
          time: { created: 10, completed: 20 },
          parentID: "msg_u1",
          modelID: "deepseek-reasoner",
          providerID: "deepseek",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      partsOf: (messageID: string) =>
        ({
          msg_u1: [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "两段回答" }],
          msg_a1: [
            { id: "prt_t1", sessionID: "ses_1", messageID: "msg_a1", type: "text", text: "第一段" },
            { id: "prt_t2", sessionID: "ses_1", messageID: "msg_a1", type: "text", text: "第二段" },
          ],
        })[messageID] ?? [],
      status: "idle",
    })
  }

  test("离屏零引擎实例;进窗恰一个;出窗即卸载(常驻实例数以窗口为上限)", async () => {
    IntersectionObserverStub.autoVisible = false
    const host = mount()
    runtime.setTimelineRows(twoMarkdownRows())
    await flush()

    const mdRows = [...host.querySelectorAll("[data-alpha-timeline-row='markdown']")]
    expect(mdRows).toHaveLength(2)
    expect(host.querySelectorAll("[data-md-stub]")).toHaveLength(0)
    expect(host.querySelectorAll(".a-tl-md-deferred")).toHaveLength(2)
    expect(mdRows.map((el) => el.getAttribute("data-engine"))).toEqual(["deferred", "deferred"])
    expect(engineRuns.count).toBe(0)

    const observer = IntersectionObserverStub.instances.at(-1)!
    observer.trigger(mdRows[0]!, true)
    await flush()
    expect(host.querySelectorAll("[data-md-stub]")).toHaveLength(1)
    expect(mdRows[0]!.getAttribute("data-engine")).toBe("live")
    expect(mdRows[1]!.getAttribute("data-engine")).toBe("deferred")

    observer.trigger(mdRows[0]!, false)
    await flush()
    expect(host.querySelectorAll("[data-md-stub]")).toHaveLength(0)
    expect(mdRows[0]!.getAttribute("data-engine")).toBe("deferred")
    expect(host.querySelectorAll(".a-tl-md-deferred")).toHaveLength(2)
  })
})

describe("REQ-125 C5 Major-2:截断等值稳定 + streaming 冻结", () => {
  test("超过上限后任意多 delta:引擎零重处理,光标熄灭,截断提示在场", async () => {
    const host = mount()
    const limit = model.MARKDOWN_MAX_CHARS
    const [text, setText] = solid.createSignal("a".repeat(limit - 10))
    const part = {
      id: "prt_big",
      sessionID: "ses_1",
      messageID: "msg_big",
      type: "text",
      get text() {
        return text()
      },
    }
    runtime.setTimelineRows([{ kind: "markdown", key: "md:prt_big", rev: "true", part, streaming: true }] as never)
    await flush()

    // 未超限:流式活跃,光标在场。
    expect(engineRuns.lastStreaming).toBe(true)
    expect(host.querySelector(".a-tl-cursor")).not.toBeNull()
    const beforeCount = engineRuns.count
    expect(beforeCount).toBeGreaterThan(0)

    // 跨过上限:恰一次冻结更新(截断即完成态)。
    setText("a".repeat(limit + 5))
    await flush()
    expect(engineRuns.count).toBe(beforeCount + 1)
    expect(engineRuns.lastStreaming).toBe(false)
    expect(host.querySelector(".a-tl-cursor")).toBeNull()
    expect(host.querySelector(".a-tl-truncated")).not.toBeNull()
    const frozenCount = engineRuns.count

    // 任意多后续 delta:截断前缀恒等 → 零引擎重处理。
    setText("a".repeat(limit + 500))
    await flush()
    setText("a".repeat(limit + 5_000))
    await flush()
    setText("a".repeat(limit * 2))
    await flush()
    expect(engineRuns.count).toBe(frozenCount)
    expect(host.querySelector(".a-tl-truncated")).not.toBeNull()
  })
})

// ═══════════════════ REQ-125 C6 — 卡片全集(工具/错误/重试/组/媒体/产物) ═══════════════════

type SolidStore = { createStore: <T extends object>(v: T) => [T, (...args: never[]) => void] }
const solidStore = (await import("solid-js/store/dist/store.js")) as unknown as SolidStore

function toolPartFixture(id: string, tool: string, state: Record<string, unknown>) {
  return { id, sessionID: "ses_1", messageID: "msg_a1", type: "tool", callID: `call_${id}`, tool, state }
}

function assistantFixture(rowsParts: unknown[], status = "idle") {
  return model.projectTimelineRows({
    messages: [
      {
        id: "msg_u1",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1000 },
        agent: "build",
        model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
      },
      {
        id: "msg_a1",
        sessionID: "ses_1",
        role: "assistant",
        time: { created: 10, completed: 20 },
        parentID: "msg_u1",
        modelID: "deepseek-reasoner",
        providerID: "deepseek",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ] as never,
    partsOf: (messageID: string) =>
      ((
        ({
          msg_u1: [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "开始" }],
          msg_a1: rowsParts,
        }) as Record<string, unknown[]>
      )[messageID] as never) ?? [],
    status,
  })
}

describe("REQ-125 C6 通用工具卡四态与分派", () => {
  test("bash 流式:运行中输出实时增行 + 块状光标;完成翻「退出 0」、光标熄灭、卡不重建", async () => {
    const host = mount()
    const [state, setState] = solidStore.createStore<Record<string, unknown>>({
      status: "running",
      input: { command: "bun test src", description: "跑一遍单元测试" },
      metadata: { output: "✓ one\n" },
      time: { start: 0 },
    })
    runtime.setTimelineRows(assistantFixture([toolPartFixture("prt_b1", "bash", state as never)], "busy"))
    await flush()

    const card = host.querySelector("[data-alpha-tool-card][data-tool='bash']")!
    expect(card.getAttribute("data-status")).toBe("running")
    expect(card.getAttribute("data-open")).toBe("true")
    const term = card.querySelector(".a-tc-term")!
    expect(term.textContent).toContain("$ bun test src")
    expect(term.textContent).toContain("✓ one")
    expect(card.querySelector(".a-tc-cursor")).not.toBeNull()
    expect(card.textContent).toContain("跑一遍单元测试")
    const cardBefore = card

    // 流式增行:同一 store proxy 的 delta,不重建卡 DOM。
    setState("metadata", { output: "✓ one\n✓ two\n" } as never)
    await flush()
    expect(host.querySelector("[data-alpha-tool-card][data-tool='bash']")).toBe(cardBefore)
    expect(card.querySelector(".a-tc-term")!.textContent).toContain("✓ two")

    // 完成:退出 0 徽标,光标消失,输出定格(卡片本体不换 —— 行 rev 稳定)。
    setState("status", "completed" as never)
    setState("metadata", { output: "✓ one\n✓ two\n", exit: 0 } as never)
    setState("output" as never, "✓ one\n✓ two\n2 pass" as never)
    runtime.setTimelineRows(assistantFixture([toolPartFixture("prt_b1", "bash", state as never)], "idle"))
    await flush()
    const done = host.querySelector("[data-alpha-tool-card][data-tool='bash']")!
    expect(done.getAttribute("data-status")).toBe("success")
    expect(done.textContent).toContain("退出 0")
    expect(done.querySelector(".a-tc-cursor")).toBeNull()
  })

  test("未知工具 fail-closed:mono 工具名 + 有界纯文本体;error 态成工具级错误卡(标题行 + 复制);超帽错误默认收起但标题/复制常驻", async () => {
    // 工具级错误卡的复制动作要真写剪贴板(CT #tools G4 帧的 .errcard-head 复制钮)。
    const copied: string[] = []
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
      configurable: true,
    })
    const gatewayLookalikeError = '{"detail":"Not Found"} — 代理 baseURL 或模型 ID 不存在'
    const host = mount()
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_m1", "context7_resolve-library-id", {
          status: "completed",
          input: {},
          output: "raw output text",
          title: "t",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_m2", "cloud_dispatch", {
          status: "error",
          input: {},
          error: "ENOTREACHABLE",
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_m3", "cloud_big", {
          status: "error",
          input: {},
          // 原长 4001 > 默认展开帽:判定按原始体量(截断标记),不用截后长度比。
          error: "E".repeat(4_001),
          time: { start: 0, end: 1 },
        }),
        // R3 Blocker:「模型网关错误」分类已整体移除(引擎无 typed gateway
        // provenance,词面判据被证明无真阳性且有可达误报,见 ToolErrorHead 注释)。
        // 网关味最浓的 task 错误文本也必须停在统一的「工具执行失败」标题。
        toolPartFixture("prt_m4", "task", {
          status: "error",
          input: { description: "诊断构建失败", subagent_type: "explore" },
          error: gatewayLookalikeError,
          time: { start: 0, end: 1 },
        }),
        // 带 gateway 字样的 webfetch 失败(502 标准原因短语)同样是通用标题。
        toolPartFixture("prt_m5", "webfetch", {
          status: "error",
          input: { url: "https://example.com" },
          error: "webfetch https://example.com failed: HTTP 502 Bad Gateway",
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const unknown = host.querySelector("[data-alpha-tool-card][data-kind='unknown']")!
    expect(unknown.querySelector(".a-tc-name")!.textContent).toBe("context7_resolve-library-id")
    ;(unknown.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    expect(unknown.querySelector(".a-tc-out")!.textContent).toContain("raw output text")

    const failed = host.querySelector("[data-alpha-tool-card][data-tool='cloud_dispatch']")!
    expect(failed.getAttribute("data-open")).toBe("true")
    expect(failed.querySelector(".a-tc-error-body")!.textContent).toContain("ENOTREACHABLE")
    expect(failed.textContent).toContain("失败")
    // 错误卡标题统一为「工具执行失败」,没有分类、没有编造的错误代码副标。
    expect(failed.querySelector(".a-tc-err-head")!.textContent).toContain("工具执行失败")
    expect(failed.querySelector(".a-tc-err-code")).toBeNull()

    const bigError = host.querySelector("[data-alpha-tool-card][data-tool='cloud_big']")!
    expect(bigError.getAttribute("data-status")).toBe("error")
    expect(bigError.getAttribute("data-open")).toBeNull()
    // R1 Major:超帽错误默认收起时,标题行与复制钮**常驻可见**,收起只藏 mono 正文。
    expect(bigError.querySelector(".a-tc-err-head")!.textContent).toContain("工具执行失败")
    expect(bigError.querySelector(".a-tc-error-body")).toBeNull()
    const bigCopy = bigError.querySelector<HTMLButtonElement>("[data-alpha-tool-error-copy]")!
    bigCopy.click()
    await flush()
    // 复制的是有界错误体(TOOL_ERROR_MAX_CHARS 帽后的 4000 字符)。
    expect(copied).toEqual(["E".repeat(4_000)])
    ;(bigError.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    expect(bigError.getAttribute("data-open")).toBe("true")
    expect(bigError.querySelector(".a-tc-error-body")!.textContent).toContain("EEEE")

    // R3 Blocker 反例:网关味最浓的 task 错误(代理 baseURL/模型 ID/Not Found)
    // 也是同一张通用错误卡 —— 标题「工具执行失败」、无代码副标、复制钮可触发。
    const taskFail = host.querySelector("[data-alpha-tool-card][data-tool='task'][data-status='error']")!
    expect(taskFail.querySelector(".a-tc-err-head")!.textContent).toContain("工具执行失败")
    expect(taskFail.querySelector(".a-tc-err-code")).toBeNull()
    const copy = taskFail.querySelector<HTMLButtonElement>("[data-alpha-tool-error-copy]")!
    expect(copy.getAttribute("aria-label")).toBe("复制错误信息")
    copy.click()
    await flush()
    expect(copied).toEqual(["E".repeat(4_000), gatewayLookalikeError])

    // R3 Blocker 反例:webfetch 的 502 Bad Gateway(标准 HTTP 原因短语自带
    // gateway 字样)同样是通用标题,不编造代码副标。
    const fetchFail = host.querySelector("[data-alpha-tool-card][data-tool='webfetch'][data-status='error']")!
    expect(fetchFail.querySelector(".a-tc-err-head")!.textContent).toContain("工具执行失败")
    expect(fetchFail.querySelector(".a-tc-err-code")).toBeNull()
  })

  test("edit diff 视图:jsdiff 行渲染 ±行号与 +/− 行;write 显示预览与总行数;补丁卡出徽章行", async () => {
    const host = mount()
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_e1", "edit", {
          status: "completed",
          input: { filePath: "/tmp/alpha-audit-test.txt" },
          output: "ok",
          title: "t",
          metadata: {
            diff: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-line two\n+hello world\n",
            filediff: { file: "x", patch: "", additions: 1, deletions: 1 },
          },
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_w1", "write", {
          status: "completed",
          input: { filePath: "/AGENTS.md", content: "# AGENTS.md\n## Architecture\nbody\nmore" },
          output: "ok",
          title: "t",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_p1", "apply_patch", {
          status: "completed",
          input: {},
          output: "ok",
          title: "t",
          metadata: {
            files: [
              { relativePath: "src/main/proxy.ts", type: "add", additions: 30, deletions: 0 },
              { relativePath: "src/main/legacy.ts", type: "delete", additions: 0, deletions: 10 },
            ],
          },
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const edit = host.querySelector("[data-alpha-tool-card][data-kind='edit']")!
    expect(edit.textContent).toContain("+1")
    expect(edit.textContent).toContain("−1")
    ;(edit.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    const diffKinds = [...edit.querySelectorAll(".a-tc-diff-line")].map((el) => el.getAttribute("data-kind"))
    expect(diffKinds).toEqual(["context", "del", "add"])
    expect(edit.querySelector(".a-tc-diff-line[data-kind='add']")!.textContent).toContain("hello world")

    const write = host.querySelector("[data-alpha-tool-card][data-kind='write']")!
    expect(write.textContent).toContain("+4")
    ;(write.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    expect(write.querySelector(".a-tc-out")!.textContent).toContain("# AGENTS.md")
    expect(write.querySelector(".a-tc-write-note")!.textContent).toContain("4")

    const patch = host.querySelector("[data-alpha-tool-card][data-kind='apply_patch']")!
    ;(patch.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    const badges = [...patch.querySelectorAll(".a-tc-badge")].map((el) => el.getAttribute("data-badge"))
    expect(badges).toEqual(["add", "delete"])
    expect(patch.textContent).toContain("新增")
    expect(patch.textContent).toContain("删除")
  })

  test("task v2 卡:agent 色点 + 运行环 + 打开子会话经 openSession intent;intent 缺席无按钮", async () => {
    const host = mount()
    runtime.setTimelineIntentsEnabled(true)
    const taskPart = toolPartFixture("prt_t1", "task", {
      status: "running",
      input: { description: "校验 AGENTS.md", subagent_type: "general" },
      metadata: { sessionId: "ses_child", parentSessionId: "ses_1" },
      time: { start: 0 },
    })
    runtime.setTimelineRows(assistantFixture([taskPart], "busy"))
    await flush()

    const card = host.querySelector("[data-alpha-tool-card][data-kind='task']")!
    expect(card.querySelector(".a-tc-agent")!.textContent).toContain("general")
    expect(card.querySelector(".a-tc-ring")).not.toBeNull()
    const open = card.querySelector(".a-tc-open") as HTMLButtonElement
    expect(open.textContent).toContain("打开子会话")
    open.click()
    expect(runtime.getIntentLog().openSession).toEqual(["ses_child"])

    runtime.setTimelineIntentsEnabled(false)
    await flush()
    expect(host.querySelector(".a-tc-open")).toBeNull()
  })

  test("read 列表行带「读取」徽章;write 预览带「写入」徽章行;大输出 bash 默认收起(I7)", async () => {
    const host = mount()
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_rd1", "read", {
          status: "completed",
          input: { filePath: "/a/README.md" },
          output: "ok",
          title: "read",
          metadata: { loaded: ["/a/AGENTS.md", "/a/CONTEXT.md"] },
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_wb1", "write", {
          status: "completed",
          input: { filePath: "/a/NOTES.md", content: "第一行\n第二行\n第三行" },
          output: "ok",
          title: "write",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_bb1", "bash", {
          status: "completed",
          input: { command: "cat big.log" },
          output: "z".repeat(5_000),
          title: "bash",
          metadata: { exit: 0 },
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const read = host.querySelector("[data-alpha-tool-card][data-kind='read']")!
    ;(read.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    const readBadges = [...read.querySelectorAll(".a-tc-badge")].map((el) => el.getAttribute("data-badge"))
    expect(readBadges).toEqual(["read", "read"])
    expect(read.querySelector(".a-tc-badge")!.textContent).toBe("读取")

    const write = host.querySelector("[data-alpha-tool-card][data-kind='write']")!
    ;(write.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    const writeBadge = write.querySelector(".a-tc-badge[data-badge='write']")!
    expect(writeBadge.textContent).toBe("写入")
    expect(write.textContent).toContain("NOTES.md")

    // 输出体超过默认展开帽 → 默认收起(用户显式展开仍可用,内容仍有界)。
    const bash = host.querySelector("[data-alpha-tool-card][data-tool='bash']")!
    expect(bash.getAttribute("data-open")).toBeNull()
    ;(bash.querySelector(".a-tc-head") as HTMLButtonElement).click()
    await flush()
    expect(bash.getAttribute("data-open")).toBe("true")
    expect(bash.querySelector(".a-tc-term")).not.toBeNull()
  })
})

describe("REQ-125 C6 折叠组/错误/重试/媒体/产物行", () => {
  test("「已探索」折叠组:计数条默认折叠,展开出行(动词+目标+参数)", async () => {
    const host = mount()
    const completed = (id: string, tool: string, input: Record<string, unknown>) =>
      toolPartFixture(id, tool, {
        status: "completed",
        input,
        output: "",
        title: tool,
        metadata: {},
        time: { start: 0, end: 1 },
      })
    runtime.setTimelineRows(
      assistantFixture([
        completed("prt_g1", "read", { filePath: "/a/README.md", limit: 30 }),
        completed("prt_g2", "grep", { pattern: "image" }),
      ]),
    )
    await flush()

    const group = host.querySelector("[data-alpha-timeline-row='toolgroup']")!
    expect(group.textContent).toContain("已探索")
    expect(group.textContent).toContain("1 次读取")
    expect(group.textContent).toContain("1 次搜索")
    expect(group.querySelector(".a-explore-body")).toBeNull()
    ;(group.querySelector(".a-explore-head") as HTMLButtonElement).click()
    await flush()
    const rows = [...group.querySelectorAll(".a-explore-row")]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain("README.md")
    expect(rows[0]!.textContent).toContain("limit=30")
    expect(rows[1]!.textContent).toContain("image")
  })

  test("回合级错误卡:全宽纯文本无动作,与工具级错误卡分离;重试卡显示第 N 次", async () => {
    const host = mount()
    runtime.setTimelineRows(
      model.projectTimelineRows({
        messages: [
          {
            id: "msg_u1",
            sessionID: "ses_1",
            role: "user",
            time: { created: 1000 },
            agent: "build",
            model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
          },
          {
            id: "msg_a1",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 10 },
            parentID: "msg_u1",
            modelID: "deepseek-reasoner",
            providerID: "deepseek",
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: { name: "rate_limit_exceeded", data: { message: "请求频率达到上限" } },
          },
        ] as never,
        partsOf: (messageID: string) =>
          (messageID === "msg_u1"
            ? [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "开始" }]
            : []) as never,
        status: "retry",
        retry: { attempt: 2, message: "gateway 429" },
      }),
    )
    await flush()

    const err = host.querySelector("[data-alpha-timeline-row='turn-error']")!
    expect(err.getAttribute("role")).toBe("alert")
    expect(err.textContent).toContain("这轮回复没有完成")
    expect(err.textContent).toContain("请求频率达到上限")
    // fail-closed:未知错误代码按原样 mono 展示,不猜翻译。
    expect(err.querySelector(".a-turn-err-code")!.textContent).toBe("rate_limit_exceeded")
    expect(err.querySelector("button")).toBeNull()

    const retry = host.querySelector("[data-alpha-timeline-row='retry']")!
    expect(retry.textContent).toContain("第 2 次")
    expect(retry.textContent).toContain("gateway 429")
  })

  test("媒体预览行:data:image 内联缩略,点击发 focusArtifact intent;intent 缺席降级纯展示", async () => {
    const host = mount()
    runtime.setTimelineIntentsEnabled(true)
    runtime.setTimelineRows(
      assistantFixture([
        {
          id: "prt_f1",
          sessionID: "ses_1",
          messageID: "msg_a1",
          type: "file",
          mime: "image/png",
          filename: "界面截图.png",
          url: "data:image/png;base64,eA==",
        },
      ]),
    )
    await flush()

    const media = host.querySelector("[data-alpha-timeline-row='media']")!
    expect(media.querySelector(".a-media-thumb img")).not.toBeNull()
    expect(media.textContent).toContain("界面截图.png")
    expect(media.textContent).toContain("PNG")
    ;(media.querySelector("button.a-media-row") as HTMLButtonElement).click()
    expect(runtime.getIntentLog().focusArtifact).toEqual([
      { name: "界面截图.png", partID: "prt_f1", mime: "image/png" },
    ])

    runtime.setTimelineIntentsEnabled(false)
    await flush()
    expect(host.querySelector("[data-alpha-timeline-row='media'] button")).toBeNull()
    expect(host.querySelector("[data-alpha-timeline-row='media'] .a-media-row")).not.toBeNull()
  })

  test("产物链接行:§⑥ 形态(链接图标+文档名),点击发 focusArtifact(runId+name)", async () => {
    const host = mount()
    runtime.setTimelineIntentsEnabled(true)
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_c1", "cloud_await", {
          status: "completed",
          input: {},
          output: JSON.stringify({
            job_id: "job_7f3a",
            status: "completed",
            artifacts: ["季度经营分析.docx", "营收对比图.png"],
          }),
          title: "await",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const rows = host.querySelector("[data-alpha-timeline-row='artifacts']")!
    expect(rows.getAttribute("role")).toBe("list")
    const links = [...rows.querySelectorAll(".a-artrow")]
    expect(links.map((el) => el.textContent)).toEqual(["季度经营分析.docx", "营收对比图.png"])
    ;(links[0] as HTMLButtonElement).click()
    expect(runtime.getIntentLog().focusArtifact).toEqual([{ name: "季度经营分析.docx", runId: "job_7f3a" }])
  })
})

// ═══════════════ #568 — 富脚注 / pill / 斜杠 chip / 诊断行 / 改动汇总 ═══════════════

describe("#568 回合末富脚注(A6/A7)", () => {
  test("完成回合渲染脚注(agent·model·时长),复制动作写剪贴板;流式回合无脚注", async () => {
    const copied: string[] = []
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
      configurable: true,
    })
    const host = mount()
    runtime.setTimelineRows(conversationRows())
    await flush()

    const footnote = host.querySelector("[data-alpha-timeline-row='footnote']")!
    expect(footnote).not.toBeNull()
    expect(footnote.querySelector(".a-tl-fn-agent")!.textContent).toContain("build")
    expect(footnote.textContent).toContain("deepseek-reasoner")
    // duration 10ms → 0 秒;零 tokens 诚实缺席。
    expect(footnote.textContent).toContain("0 秒")
    expect(footnote.textContent).not.toContain("tokens")

    const copy = footnote.querySelector<HTMLButtonElement>(".a-tl-fn-actions button")!
    expect(copy.getAttribute("aria-label")).toBe("复制回复")
    copy.click()
    await flush()
    expect(copied).toEqual(["**发现**:结构完好"])

    // 流式回合(assistant 未完成)不出脚注。
    runtime.setTimelineRows(conversationRows("busy"))
    await flush()
    expect(host.querySelector("[data-alpha-timeline-row='footnote']")).toBeNull()
  })
})

describe("#568 「在面板打开」pill(T8)", () => {
  test("write/edit 卡头出 pill,点击发 openFile intent;intent 缺席零渲染;read 卡永无 pill", async () => {
    const host = mount()
    runtime.setTimelineIntentsEnabled(true)
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_w1", "write", {
          status: "completed",
          input: { filePath: "/repo/AGENTS.md", content: "# a\nb" },
          output: "ok",
          title: "write",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
        toolPartFixture("prt_rd1", "read", {
          status: "completed",
          input: { filePath: "/repo/README.md" },
          output: "ok",
          title: "read",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const write = host.querySelector("[data-alpha-tool-card][data-kind='write']")!
    const pill = write.querySelector<HTMLButtonElement>(".a-tc-openp")!
    expect(pill.textContent).toContain("在面板打开")
    pill.click()
    expect(runtime.getIntentLog().openFile).toEqual([{ path: "/repo/AGENTS.md" }])
    expect(host.querySelector("[data-alpha-tool-card][data-kind='read'] .a-tc-openp")).toBeNull()

    // fail-closed:openFile handler 缺席 → pill 消失,卡头照常。
    runtime.setTimelineIntentsEnabled(false)
    await flush()
    expect(host.querySelector(".a-tc-openp")).toBeNull()
    expect(write.querySelector(".a-tc-head")).not.toBeNull()
  })
})

describe("#568 斜杠命令 chip(消费可选 typed 接口)", () => {
  function slashRows(withOrigin: boolean) {
    return model.projectTimelineRows({
      messages: [
        {
          id: "msg_u1",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
        },
        {
          id: "msg_a1",
          sessionID: "ses_1",
          role: "assistant",
          time: { created: 10, completed: 20 },
          parentID: "msg_u1",
          modelID: "deepseek-reasoner",
          providerID: "deepseek",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ] as never,
      partsOf: (messageID: string) =>
        (messageID === "msg_u1"
          ? [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "expanded prompt body" }]
          : [{ id: "prt_t1", sessionID: "ses_1", messageID: "msg_a1", type: "text", text: "done" }]) as never,
      status: "idle",
      slashOrigins: withOrigin ? [{ assistantMessageID: "msg_a1", command: "review", arguments: "pr 12" }] : undefined,
    })
  }

  test("登记在场:气泡换 chip(命令+参数),展开提示词默认折叠、点击展开;登记缺席零渲染", async () => {
    const host = mount()
    runtime.setTimelineRows(slashRows(true))
    await flush()

    const cmd = host.querySelector("[data-alpha-timeline-slash]")!
    expect(cmd).not.toBeNull()
    const chip = cmd.querySelector<HTMLButtonElement>("button.a-tl-cmd-chip")!
    expect(chip.querySelector(".a-tl-cmd-name")!.textContent).toBe("review")
    expect(chip.querySelector(".a-tl-cmd-args")!.textContent).toBe("pr 12")
    expect(chip.getAttribute("aria-expanded")).toBe("false")
    expect(cmd.querySelector(".a-tl-cmd-body")).toBeNull()
    expect(host.textContent).not.toContain("expanded prompt body")

    chip.click()
    await flush()
    expect(chip.getAttribute("aria-expanded")).toBe("true")
    expect(cmd.querySelector(".a-tl-cmd-body")!.textContent).toContain("expanded prompt body")

    runtime.setTimelineRows(slashRows(false))
    await flush()
    expect(host.querySelector("[data-alpha-timeline-slash]")).toBeNull()
    expect(host.querySelector(".a-tl-bubble")!.textContent).toContain("expanded prompt body")
  })
})

describe("#568 诊断行(T19)", () => {
  test("edit 卡渲染本文件 ERROR 级诊断(mono 行,1 基行号);低级别与他文件忽略", async () => {
    const host = mount()
    runtime.setTimelineRows(
      assistantFixture([
        toolPartFixture("prt_e1", "edit", {
          status: "completed",
          input: { filePath: "/repo/app/prompt_builder.py" },
          output: "ok",
          title: "edit",
          metadata: {
            diagnostics: {
              "/repo/app/prompt_builder.py": [
                {
                  severity: 1,
                  message: '"kama_latest" is possibly unbound',
                  range: { start: { line: 101, character: 4 } },
                },
                { severity: 2, message: "unused import", range: { start: { line: 3, character: 0 } } },
              ],
              "/repo/other.py": [{ severity: 1, message: "elsewhere", range: { start: { line: 0, character: 0 } } }],
            },
          },
          time: { start: 0, end: 1 },
        }),
      ]),
    )
    await flush()

    const rows = [...host.querySelectorAll(".a-tc-diag-row")]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelector(".a-tc-diag-lvl")!.textContent).toBe("ERR")
    expect(rows[0]!.querySelector(".a-tc-diag-loc")!.textContent).toBe("prompt_builder.py:102")
    expect(rows[0]!.querySelector(".a-tc-diag-msg")!.textContent).toBe('"kama_latest" is possibly unbound')
  })
})

describe("#568 本回合改动汇总(S2)", () => {
  function diffsumRows() {
    return model.projectTimelineRows({
      messages: [
        {
          id: "msg_u1",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
          summary: {
            diffs: [
              { file: "AGENTS.md", additions: 96, deletions: 0 },
              { file: "alpha-ui/button.css", additions: 8, deletions: 2 },
            ],
          },
        },
      ] as never,
      partsOf: () =>
        [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "改一版" }] as never,
      status: "idle",
    })
  }

  test("汇总头(计数+徽标)默认折叠;展开出文件行,点击经 openFile 联动;intent 缺席行降级纯展示", async () => {
    const host = mount()
    runtime.setTimelineIntentsEnabled(true)
    runtime.setTimelineRows(diffsumRows())
    await flush()

    const diffsum = host.querySelector("[data-alpha-timeline-row='diffsum']")!
    const head = diffsum.querySelector<HTMLButtonElement>(".a-diffsum-head")!
    expect(head.textContent).toContain("本回合改动 · 2 个文件")
    expect(head.textContent).toContain("+104")
    expect(head.textContent).toContain("−2")
    expect(head.getAttribute("aria-expanded")).toBe("false")
    expect(diffsum.querySelector(".a-diffsum-body")).toBeNull()

    head.click()
    await flush()
    const rows = [...diffsum.querySelectorAll<HTMLButtonElement>("button.a-diffsum-row")]
    expect(rows).toHaveLength(2)
    expect(rows[1]!.textContent).toContain("button.css")
    rows[0]!.click()
    expect(runtime.getIntentLog().openFile).toEqual([{ path: "AGENTS.md" }])

    runtime.setTimelineIntentsEnabled(false)
    await flush()
    expect(diffsum.querySelector("button.a-diffsum-row")).toBeNull()
    expect(diffsum.querySelectorAll("div.a-diffsum-row")).toHaveLength(2)
  })
})

describe("#568 终局接线:C7 斜杠登记 → chip 渲染(端到端)", () => {
  test("recordSessionSlashOrigin 登记经 sessionSlashOriginsFor 供给投影,chip 按稿渲染;他会话身份零供给", async () => {
    const slash = await import("../src/renderer/alpha-ui/session-workspace/session-slash-origin")
    slash.resetSessionSlashOrigins()
    const identity = { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_1" }
    slash.recordSessionSlashOrigin({
      identity,
      command: "review",
      arguments: "pr 12",
      assistantMessageID: "msg_a1",
      at: 1,
    })

    const host = mount()
    runtime.setTimelineRows(
      model.projectTimelineRows({
        messages: [
          {
            id: "msg_u1",
            sessionID: "ses_1",
            role: "user",
            time: { created: 1000 },
            agent: "build",
            model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
          },
          {
            id: "msg_a1",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 10, completed: 20 },
            parentID: "msg_u1",
            modelID: "deepseek-reasoner",
            providerID: "deepseek",
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ] as never,
        partsOf: (messageID: string) =>
          (messageID === "msg_u1"
            ? [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "expanded prompt" }]
            : []) as never,
        status: "idle",
        // 真供给:C7 registry 的读取口,workspace 装配同一函数。
        slashOrigins: slash.sessionSlashOriginsFor(identity),
      }),
    )
    await flush()

    const chip = host.querySelector("[data-alpha-timeline-slash] .a-tl-cmd-chip")!
    expect(chip).not.toBeNull()
    expect(chip.querySelector(".a-tl-cmd-name")!.textContent).toBe("review")
    expect(chip.querySelector(".a-tl-cmd-args")!.textContent).toBe("pr 12")

    // I8:他会话身份读不到该登记(供给为空 → chip 不渲染的前提由 registry 保证)。
    expect(slash.sessionSlashOriginsFor({ ...identity, sessionID: "ses_other" })).toHaveLength(0)
    slash.resetSessionSlashOrigins()
  })
})
