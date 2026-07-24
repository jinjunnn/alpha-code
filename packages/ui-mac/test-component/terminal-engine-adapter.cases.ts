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

// ── 假引擎:上游 useTerminal 的最小同形面(focus store 语义照搬 context/terminal.tsx;
//    ops.update 真实落 store,让新挂载能捕获回写后的 buffer/cursor) ──
type FakePTY = { id: string; title: string; titleNumber: number; cols?: number; rows?: number; cursor?: number; buffer?: string }

function createFakeEngine(initial: FakePTY[], options?: { silentCleanup?: boolean; manualFlush?: boolean }) {
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
      update: (next: Partial<FakePTY> & { id: string }) => {
        opsCalls.push(`update:${next.id}:cursor=${next.cursor ?? "unset"}`)
        setAll((current) => current.map((pty) => (pty.id === next.id ? { ...pty, ...next } : pty)))
      },
      clone: (id: string) => {
        opsCalls.push(`clone:${id}`)
        return Promise.resolve()
      },
    }),
  }
  return {
    engine,
    focus,
    setAll,
    opsCalls,
    silentCleanup: options?.silentCleanup === true,
    manualFlush: options?.manualFlush === true,
  }
}

let currentEngine: ReturnType<typeof createFakeEngine> | undefined
const mountLog: string[] = []
/** manualFlush 模式:被卸实例的回写由测试手动触发(可覆写载荷),复现迟到回写交错。 */
const heldFlushes: Array<{ mountIndex: number; fire: (payload?: Partial<FakePTY>) => void }> = []

// ── 假 Terminal:上游一次性 autoFocus 语义(挂载期读一次;true 即消费)+ 上游真实的
//    异步回写语义 —— 卸载后 output.flush(finalize) 完成才回调 onCleanup(延迟一个
//    macrotask),载荷携带比挂载时前进了的 buffer/cursor(模拟活动中的终端)。 ──
function FakeTerminal(props: {
  pty: FakePTY
  autoFocus?: boolean
  onAutoFocus?: () => void
  onCleanup?: (next: Partial<FakePTY> & { id: string }) => void
}) {
  const autoFocus = props.autoFocus === true
  const capturedCursor = props.pty.cursor ?? 0
  const mountIndex = mountLog.length
  // 挂载即捕获当时 store 的 cursor:两相位正确性判据 —— 重挂的新实例必须拿到回写后的值。
  mountLog.push(`mount:${props.pty.id}:af=${autoFocus}:cursor=${capturedCursor}`)
  if (autoFocus) props.onAutoFocus?.()
  const liveCursor = capturedCursor + 100 // 挂载存活期间终端又前进了(回写前 store 是旧值)
  solid.onCleanup(() => {
    if (currentEngine?.silentCleanup) return
    const fire = (payload?: Partial<FakePTY>) =>
      props.onCleanup?.({ id: props.pty.id, cursor: liveCursor, buffer: "flushed", ...payload })
    if (currentEngine?.manualFlush) {
      heldFlushes.push({ mountIndex, fire })
      return
    }
    setTimeout(() => fire(), 0)
  })
  const el = document.createElement("div")
  el.setAttribute("data-fake-terminal", props.pty.id)
  el.setAttribute("data-autofocus", autoFocus ? "true" : "false")
  el.setAttribute("data-cursor", String(capturedCursor))
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
  heldFlushes.splice(0)
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

async function macrotask() {
  await new Promise((resolve) => setTimeout(resolve, 1))
  await flush()
}

describe("REQ-125 #554 keep-alive × autoFocus one-shot, two-phase remount (audit rounds 4-5)", () => {
  test("remount waits for the old instance's async write-back; the new mount captures the flushed store", async () => {
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1, cursor: 0 }])
    const { host, channel } = mountEngineOutput("pty_1")
    await flush()

    // First mount without a pending request: no autoFocus, captures cursor 0.
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0"])

    // Shell reshow handoff: request arrives while the output stays mounted (keep-alive).
    channel().requestFocus(channel().activeID())
    await flush()

    // Pending phase: the old instance is torn down and NOTHING mounts yet — a synchronous
    // remount here would capture the stale cursor (the round-5 race).
    expect(host.querySelectorAll("[data-fake-terminal]")).toHaveLength(0)
    expect(mountLog).toHaveLength(1)

    // A further request during pending coalesces — no epoch stacking.
    channel().requestFocus("pty_1")
    await flush()
    expect(mountLog).toHaveLength(1)

    // The async flush lands (one macrotask): write-back first, then exactly one new mount
    // that captures the flushed cursor and consumes the request via native autoFocus.
    await macrotask()
    expect(currentEngine.opsCalls).toContain("update:pty_1:cursor=100")
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0", "mount:pty_1:af=true:cursor=100"])
    const terminals = host.querySelectorAll("[data-fake-terminal]")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.getAttribute("data-autofocus")).toBe("true")
    expect(terminals[0]!.getAttribute("data-cursor")).toBe("100")
    expect(currentEngine.engine.focusRequested("pty_1")).toBe(false)
    expect(currentEngine.focus()).toBeUndefined()

    // No self-sustaining remount loop after consumption.
    await macrotask()
    expect(mountLog).toHaveLength(2)

    // Repeatability: the next reshow request runs the same two-phase cycle (cursor 100→200).
    channel().requestFocus("pty_1")
    await flush()
    expect(mountLog).toHaveLength(2)
    await macrotask()
    expect(mountLog).toEqual([
      "mount:pty_1:af=false:cursor=0",
      "mount:pty_1:af=true:cursor=100",
      "mount:pty_1:af=true:cursor=200",
    ])
    expect(currentEngine.focus()).toBeUndefined()
  })

  test("a request already pending at first mount uses the native autoFocus with zero delay", async () => {
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1, cursor: 0 }])
    currentEngine.engine.requestFocus("pty_1")
    const { host } = mountEngineOutput("pty_1")
    await flush()

    expect(mountLog).toEqual(["mount:pty_1:af=true:cursor=0"])
    expect(host.querySelector("[data-fake-terminal]")!.getAttribute("data-autofocus")).toBe("true")
    expect(currentEngine.focus()).toBeUndefined()
    await macrotask()
    expect(mountLog).toHaveLength(1)
  })

  test("a foreign-instance request neither remounts nor consumes", async () => {
    currentEngine = createFakeEngine([
      { id: "pty_1", title: "终端 1", titleNumber: 1 },
      { id: "pty_2", title: "终端 2", titleNumber: 2 },
    ])
    const { channel } = mountEngineOutput("pty_1")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0"])

    channel().requestFocus("pty_2")
    await macrotask()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0"])
    // The request stays pending for its rightful instance.
    expect(currentEngine.engine.focusRequested("pty_2")).toBe(true)
  })

  test("a late write-back from an earlier generation never completes a newer pending (round-6 token)", async () => {
    // 复现序:A 卸载但 flush 迟迟不回 → 300ms 兜底挂 B → B 再进 pending → A 的迟到
    // 回写(同 PTY id)到达 —— 它绝不能误完成 B 的 pending;C 必须等到 B 的回写才挂。
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1, cursor: 0 }], {
      manualFlush: true,
    })
    const { host, channel } = mountEngineOutput("pty_1")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0"]) // A = 代次 1

    // A 卸载,flush 被扣住;300ms 兜底后 B 挂载(store 未回写,诚实 cursor=0)。
    channel().requestFocus("pty_1")
    await flush()
    expect(heldFlushes).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0", "mount:pty_1:af=true:cursor=0"]) // B = 代次 2

    // B 再进 pending(等待代次 2 的回写);B 的 flush 也被扣住。
    channel().requestFocus("pty_1")
    await flush()
    expect(host.querySelectorAll("[data-fake-terminal]")).toHaveLength(0)
    expect(heldFlushes).toHaveLength(2)

    // A 的迟到回写到达:只落 store,绝不推 B 的 pending —— 不许挂出拿过期 cursor 的 C。
    heldFlushes[0]!.fire({ cursor: 111 })
    await flush()
    expect(mountLog).toHaveLength(2)
    expect(host.querySelectorAll("[data-fake-terminal]")).toHaveLength(0)
    expect(currentEngine.opsCalls).toContain("update:pty_1:cursor=111")

    // B 的回写到达:pending 才完成,C 捕获的是 B 回写后的 store。
    heldFlushes[1]!.fire({ cursor: 222 })
    await flush()
    expect(mountLog).toEqual([
      "mount:pty_1:af=false:cursor=0",
      "mount:pty_1:af=true:cursor=0",
      "mount:pty_1:af=true:cursor=222",
    ])
    expect(host.querySelector("[data-fake-terminal]")!.getAttribute("data-cursor")).toBe("222")
    expect(currentEngine.focus()).toBeUndefined()
  })

  test("when the old instance never flushes, the timeout fallback still mounts and consumes", async () => {
    currentEngine = createFakeEngine([{ id: "pty_1", title: "终端 1", titleNumber: 1, cursor: 0 }], {
      silentCleanup: true,
    })
    const { host, channel } = mountEngineOutput("pty_1")
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0"])

    channel().requestFocus("pty_1")
    await macrotask()
    // No write-back will ever arrive — still pending well past the flush macrotask.
    expect(host.querySelectorAll("[data-fake-terminal]")).toHaveLength(0)

    // The 300ms fallback opens the mount phase so the panel can never wedge empty.
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flush()
    expect(mountLog).toEqual(["mount:pty_1:af=false:cursor=0", "mount:pty_1:af=true:cursor=0"])
    expect(currentEngine.focus()).toBeUndefined()
  })
})
