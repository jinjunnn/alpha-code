// REQ-125 #554 / 审计第 4 轮 Major-2 —— 适配器 EngineOutput 的 DOM 级取证。
// 上游窄导出被 mock 成「一次性 autoFocus」语义的假 Terminal(与
// packages/app/src/components/terminal.tsx 的挂载期消费一致),假 useTerminal 携
// 上游同形的 focus store 语义;判据 = 重显后的聚焦请求被「真实消费」(挂载记录 +
// data-autofocus 标记 + focus store 清空),不允许只断言 request 调用。
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

// ── 假引擎:上游 useTerminal 的最小同形面(focus store 语义照搬 context/terminal.tsx) ──
type FakePTY = { id: string; title: string; titleNumber: number; cols?: number; rows?: number }

function createFakeEngine(initial: FakePTY[]) {
  const [focus, setFocus] = solid.createSignal<{ id?: string } | undefined>(undefined)
  const [all, setAll] = solid.createSignal<FakePTY[]>(initial)
  const opsCalls: string[] = []
  const engine = {
    ready: () => true,
    all,
    active: () => all()[0]?.id,
    open(_id: string) {},
    close: (_id: string) => Promise.resolve(),
    new(_options?: { focus?: boolean }) {},
    requestFocus: (id?: string) => setFocus({ id }),
    cancelFocus: () => setFocus(undefined),
    focusRequested: (id?: string) => {
      const current = focus()
      if (!id || !current) return false
      return !current.id || current.id === id
    },
    consumeFocus: (id: string) => {
      if (engine.focusRequested(id)) setFocus(undefined)
    },
    bind: () => ({
      trim: (id: string) => void opsCalls.push(`trim:${id}`),
      update: (next: { id: string }) => void opsCalls.push(`update:${next.id}`),
      clone: (id: string) => {
        opsCalls.push(`clone:${id}`)
        return Promise.resolve()
      },
    }),
  }
  return { engine, focus, setAll, opsCalls }
}

let currentEngine: ReturnType<typeof createFakeEngine> | undefined
const mountLog: string[] = []

// ── 假 Terminal:上游一次性 autoFocus 语义(挂载期读一次;true 即消费) ──
function FakeTerminal(props: {
  pty: FakePTY
  autoFocus?: boolean
  onAutoFocus?: () => void
  onCleanup?: (next: { id: string }) => void
}) {
  const autoFocus = props.autoFocus === true
  mountLog.push(`mount:${props.pty.id}:af=${autoFocus}`)
  if (autoFocus) props.onAutoFocus?.()
  solid.onCleanup(() => props.onCleanup?.({ id: props.pty.id }))
  const el = document.createElement("div")
  el.setAttribute("data-fake-terminal", props.pty.id)
  el.setAttribute("data-autofocus", autoFocus ? "true" : "false")
  return el
}

mock.module("@opencode-ai/app/surface/terminal", () => ({
  Terminal: FakeTerminal,
  useTerminal: () => currentEngine!.engine,
}))

Bun.plugin({
  name: "terminal-engine-adapter-component-test",
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

const adapter = await import("../src/renderer/alpha-ui/session-rail/terminal/terminal-engine-adapter")
const disposers: Array<() => void> = []

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
  mountLog.splice(0)
  currentEngine = undefined
})

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

const snapshot = {
  identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_term" },
  project: "workspace",
  title: "整理架构说明",
  activity: "idle" as const,
}

function mountEngineOutput(instanceID: string) {
  const host = document.createElement("div")
  document.body.append(host)
  let channel: ReturnType<ReturnType<typeof adapter.useAlphaTerminalEngineChannel>>
  disposers.push(
    solidWeb.render(() => {
      const accessor = adapter.useAlphaTerminalEngineChannel(() => snapshot)
      channel = accessor()
      return channel!.EngineOutput({ instanceID }) as never
    }, host),
  )
  return { host, channel: () => channel! }
}

describe("REQ-125 #554 keep-alive × autoFocus one-shot (audit round-4 Major-2)", () => {
  test("a focus request while mounted remounts once and is truly consumed", async () => {
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1 }])
    const { host, channel } = mountEngineOutput("pty_1")
    await flush()

    // First mount without a pending request: no autoFocus, nothing consumed.
    expect(mountLog).toEqual(["mount:pty_1:af=false"])
    expect(host.querySelector("[data-fake-terminal]")!.getAttribute("data-autofocus")).toBe("false")

    // Shell reshow handoff: request arrives while the output stays mounted (keep-alive).
    channel().requestFocus(channel().activeID())
    await flush()

    // One keyed remount, autoFocus taken by the native path, request actually consumed.
    expect(mountLog).toEqual(["mount:pty_1:af=false", "mount:pty_1:af=true"])
    const terminals = host.querySelectorAll("[data-fake-terminal]")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.getAttribute("data-autofocus")).toBe("true")
    expect(currentEngine.engine.focusRequested("pty_1")).toBe(false)
    expect(currentEngine.focus()).toBeUndefined()
    // The teardown of the previous mount wrote state back (scrollback persistence glue).
    expect(currentEngine.opsCalls).toContain("update:pty_1")

    // No self-sustaining remount loop after consumption.
    await flush()
    expect(mountLog).toHaveLength(2)

    // Repeatability: every later reshow request is consumed the same way.
    channel().requestFocus("pty_1")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false", "mount:pty_1:af=true", "mount:pty_1:af=true"])
    expect(currentEngine.focus()).toBeUndefined()
  })

  test("a request already pending at first mount uses the native autoFocus without an extra remount", async () => {
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1 }])
    currentEngine.engine.requestFocus("pty_1")
    const { host } = mountEngineOutput("pty_1")
    await flush()

    expect(mountLog).toEqual(["mount:pty_1:af=true"])
    expect(host.querySelector("[data-fake-terminal]")!.getAttribute("data-autofocus")).toBe("true")
    expect(currentEngine.focus()).toBeUndefined()
    await flush()
    expect(mountLog).toHaveLength(1)
  })

  test("a foreign-instance request neither remounts nor consumes", async () => {
    currentEngine = createFakeEngine([
      { id: "pty_1", title: "终端 1", titleNumber: 1 },
      { id: "pty_2", title: "终端 2", titleNumber: 2 },
    ])
    const { channel } = mountEngineOutput("pty_1")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false"])

    channel().requestFocus("pty_2")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false"])
    // The request stays pending for its rightful instance.
    expect(currentEngine.engine.focusRequested("pty_2")).toBe(true)
  })
})
