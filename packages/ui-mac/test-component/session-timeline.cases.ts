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

mock.module("@opencode-ai/session-ui/markdown", () => ({
  Markdown: (props: { text?: string; streaming?: boolean; class?: string }) => {
    const el = document.createElement("div")
    el.setAttribute("data-md-stub", "")
    if (props.class) el.className = props.class
    el.textContent = props.text ?? ""
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
              opencodeComment: { path: "button.css", comment: "焦点环别再隐藏", selection: { startLine: 42, endLine: 42 } },
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
    expect(kinds).toEqual(["user", "reasoning", "placeholder", "markdown", "turn", "user"])

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

    const placeholder = host.querySelector("[data-alpha-timeline-row='placeholder']")!
    expect(placeholder.getAttribute("data-tool")).toBe("bash")
    expect(placeholder.textContent).toContain("运行中")

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
        partsOf: () => [
          { id: "prt_u9", sessionID: "ses_1", messageID: "msg_u9", type: "text", text: "开始" },
        ],
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
