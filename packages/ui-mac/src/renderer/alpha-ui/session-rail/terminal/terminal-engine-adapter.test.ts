// REQ-125 #554 —— 终端引擎 channel 适配器:纯投影半场直测 + I1 白名单通道静态断言。
//
// 适配器分两半:terminal-engine-adapter-core.ts(纯投影,本文件直测)与
// terminal-engine-adapter.tsx(唯一引擎 import 点,bun 下无法加载上游链 —— ghostty/vite
// 别名,故以静态锚点钉死其粘合语义与 import 收敛面)。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { Component } from "solid-js"
import { sameSessionIdentity, type AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import {
  mintTerminalEngineChannel,
  sameIdentityProjection,
  terminalFootStatus,
  terminalInstanceTitle,
  type TerminalEngineHandle,
  type TerminalEnginePTY,
  type TerminalEngineSurface,
} from "./terminal-engine-adapter-core"
import { acceptedEngineChannel } from "./terminal-rail-core"

const RENDERER = resolve(import.meta.dir, "../..", "..")
const ADAPTER_REL = "alpha-ui/session-rail/terminal/terminal-engine-adapter.tsx"
const adapterSource = readFileSync(join(RENDERER, ADAPTER_REL), "utf8")
const coreSource = readFileSync(join(import.meta.dir, "terminal-engine-adapter-core.ts"), "utf8")
const workspaceSource = readFileSync(
  join(RENDERER, "alpha-ui/session-workspace/alpha-session-workspace.tsx"),
  "utf8",
)

const labels = { numbered: (number: number) => `终端 ${number}`, untitled: "终端" }

const identityOf = (sessionID: string): AlphaSessionIdentity => ({
  serverKey: "sidecar",
  directory: "/tmp/workspace",
  sessionID,
})

const pty = (id: string, extra?: Partial<TerminalEnginePTY>): TerminalEnginePTY => ({
  id,
  title: `Terminal ${id}`,
  titleNumber: 1,
  ...extra,
})

function fakeEngine(all: TerminalEnginePTY[] = [pty("pty_1", { cols: 80, rows: 24 }), pty("pty_2")]) {
  const calls: string[] = []
  const surface: TerminalEngineSurface = {
    ready: () => true,
    all: () => all,
    active: () => all[0]?.id,
    open: (id) => void calls.push(`open:${id}`),
    close: (id) => {
      calls.push(`close:${id}`)
      return Promise.resolve()
    },
    new: (options) => void calls.push(`new:${options?.focus === true}`),
    requestFocus: (id) => void calls.push(`requestFocus:${id ?? "unset"}`),
    cancelFocus: () => void calls.push("cancelFocus"),
  }
  const EngineOutput: Component<{ instanceID: string }> = () => null
  const handle: TerminalEngineHandle = { surface, EngineOutput }
  return { handle, calls, EngineOutput }
}

// 剥掉注释行:静态断言约束的是代码;注释里允许指名上游落点(勘破记录)。
const codeLines = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")

/** renderer 下全部非测试 ts/tsx 源(用于扫窄导出消费者)。 */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield p
  }
}

describe("REQ-125 #554 channel minting (I8 identity binding, fail-closed)", () => {
  test("engine or identity absent mints no channel (panel falls closed to the empty state)", () => {
    const { handle } = fakeEngine()
    expect(mintTerminalEngineChannel({ engine: undefined, identity: identityOf("ses_a"), labels })).toBeUndefined()
    expect(mintTerminalEngineChannel({ engine: handle, identity: undefined, labels })).toBeUndefined()
    expect(mintTerminalEngineChannel({ engine: undefined, identity: undefined, labels })).toBeUndefined()
  })

  test("the minted channel carries the session identity triple and passes the accepts gate only while live", () => {
    const { handle } = fakeEngine()
    const identity = identityOf("ses_a")
    const channel = mintTerminalEngineChannel({ engine: handle, identity, labels })!
    expect(channel.identity).toBe(identity)

    const acceptsOf = (live: AlphaSessionIdentity) => (candidate: AlphaSessionIdentity) =>
      sameSessionIdentity(candidate, live)
    // 当前会话接受;同 workspace 切会话后旧投影被拒(I8 fail-closed,与 C550 闸复合)。
    expect(acceptedEngineChannel(channel, acceptsOf(identity))).toBe(channel)
    expect(acceptedEngineChannel(channel, acceptsOf(identityOf("ses_b")))).toBeUndefined()
  })

  test("channel operations delegate to the engine; create requests focus like the upstream panel", () => {
    const { handle, calls, EngineOutput } = fakeEngine()
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!

    expect(channel.ready()).toBe(true)
    expect(channel.activeID()).toBe("pty_1")
    expect(channel.EngineOutput).toBe(EngineOutput)
    channel.open("pty_2")
    channel.close("pty_2")
    channel.create()
    // #554 焦点交接请求端:open 先发聚焦请求再切激活(上游页签语义,请求须在重挂前就位)。
    expect(calls).toEqual(["requestFocus:pty_2", "open:pty_2", "close:pty_2", "new:true"])
  })

  test("focus handoff request side delegates: request an instance, request the active one, cancel", () => {
    const { handle, calls } = fakeEngine()
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!

    channel.requestFocus("pty_2")
    channel.requestFocus(undefined)
    channel.cancelFocus()
    expect(calls).toEqual(["requestFocus:pty_2", "requestFocus:unset", "cancelFocus"])
  })

  test("instances project engine data without fabrication: running is always false today", () => {
    const { handle } = fakeEngine([
      pty("pty_1", { title: "构建产物" }),
      pty("pty_2", { title: "", titleNumber: 3 }),
      pty("pty_3", { title: "  ", titleNumber: 0 }),
    ])
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!
    expect(channel.instances()).toEqual([
      { id: "pty_1", title: "构建产物", running: false },
      { id: "pty_2", title: "终端 3", running: false },
      { id: "pty_3", title: "终端", running: false },
    ])
  })

  test("foot status passes persisted size through and never invents running or shell data", () => {
    const { handle } = fakeEngine()
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!
    expect(channel.footStatus("pty_1")).toEqual({ running: false, cols: 80, rows: 24 })
    expect(channel.footStatus("pty_2")).toEqual({ running: false, cols: undefined, rows: undefined })
    expect(channel.footStatus("pty_gone")).toEqual({ running: false, cols: undefined, rows: undefined })
    expect(terminalFootStatus(undefined)).toEqual({ running: false, cols: undefined, rows: undefined })
  })

  test("tab titles prefer engine data and fall back without inventing labels", () => {
    expect(terminalInstanceTitle({ title: "yarn dev", titleNumber: 2 }, labels)).toBe("yarn dev")
    expect(terminalInstanceTitle({ title: "", titleNumber: 2 }, labels)).toBe("终端 2")
    expect(terminalInstanceTitle({ title: "", titleNumber: 0 }, labels)).toBe("终端")
    expect(terminalInstanceTitle({ title: "", titleNumber: Number.NaN }, labels)).toBe("终端")
  })

  test("identity projection equality: both-absent or equal triples are stable, everything else re-mints", () => {
    const identity = identityOf("ses_a")
    expect(sameIdentityProjection(undefined, undefined)).toBe(true)
    expect(sameIdentityProjection(identity, undefined)).toBe(false)
    expect(sameIdentityProjection(undefined, identity)).toBe(false)
    expect(sameIdentityProjection(identity, identityOf("ses_a"))).toBe(true)
    expect(sameIdentityProjection(identity, identityOf("ses_b"))).toBe(false)
    expect(sameIdentityProjection(identity, { ...identity, directory: "/tmp/other" })).toBe(false)
    expect(sameIdentityProjection(identity, { ...identity, serverKey: "remote" })).toBe(false)
  })
})

describe("REQ-125 #554 I1 whitelist channel static ratchets", () => {
  test("the narrow terminal export has exactly one renderer consumer: the adapter file", () => {
    const importers: string[] = []
    for (const file of walk(RENDERER)) {
      if (codeLines(readFileSync(file, "utf8")).includes("@opencode-ai/app/surface/terminal")) {
        importers.push(relative(RENDERER, file))
      }
    }
    expect(importers).toEqual([ADAPTER_REL])
  })

  test("the adapter imports the engine only through the narrow export and touches no other upstream face", () => {
    const code = codeLines(adapterSource)
    const upstreamImports = [...code.matchAll(/from "(@opencode-ai\/[^"]+)"/g)].map((match) => match[1])
    expect(upstreamImports).toEqual(["@opencode-ai/app/surface/terminal"])
    for (const token of ["@opencode-ai/ui", "@opencode-ai/session-ui", "app/src/", "querySelector", "MutationObserver"]) {
      expect(code).not.toContain(token)
    }
    // 引擎与数据通道不得在 alpha 侧重实现(白名单 = 复用,不是重写)。
    expect(code).not.toContain("ghostty-web")
    expect(code).not.toContain("new WebSocket")
  })

  test("the pure half stays engine-import free", () => {
    expect(codeLines(coreSource)).not.toContain("@opencode-ai")
  })

  test("adapter glue keeps the upstream terminal-panel semantics and the identity-stable projection", () => {
    // 身份 memo 用三元组 equals:快照抖动不得重铸(重铸 = keyed 引擎输出重挂/重连)。
    expect(adapterSource).toContain("createMemo(() => current()?.identity, undefined, { equals: sameIdentityProjection })")
    // 引擎缺席 fail-closed 成 channel 缺席,不升级成 Recovery 崩溃。
    expect(adapterSource).toContain("function resolveTerminalEngine()")
    expect(adapterSource).toMatch(/try \{\s*return useTerminal\(\)\s*\} catch \{\s*return undefined\s*\}/)
    // 粘合语义对齐上游 terminal-panel:持久化回写、连接后 trim、一次性 clone 恢复、聚焦交接。
    expect(adapterSource).toContain("onCleanup={(next) => ops.update(next)}")
    expect(adapterSource).toContain("ops.trim(props.instanceID)")
    expect(adapterSource).toContain("void ops.clone(props.instanceID)")
    expect(adapterSource).toContain("autoFocus={engine.focusRequested(props.instanceID)}")
    expect(adapterSource).toContain("onAutoFocus={() => engine.consumeFocus(props.instanceID)}")
  })

  test("the workspace wires the real channel into the shell", () => {
    expect(workspaceSource).toContain(
      'import { useAlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-engine-adapter"',
    )
    expect(workspaceSource).toContain("const terminalChannel = useAlphaTerminalEngineChannel(current)")
    expect(workspaceSource).toContain("terminalChannel={terminalChannel}")
  })
})
