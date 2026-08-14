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
  terminalShellName,
  type TerminalEngineHandle,
  type TerminalEnginePTY,
  type TerminalEngineSurface,
} from "./terminal-engine-adapter-core"
import { acceptedEngineChannel, anyTerminalRunning } from "./terminal-rail-core"

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

// 默认夹具:pty_1 带服务端下发的 command(#579),pty_2 **不带** —— 「缺数据不伪造」的
// 负向对照必须与正向对照在同一次挂载里并存。
function fakeEngine(
  all: TerminalEnginePTY[] = [pty("pty_1", { cols: 80, rows: 24, command: "/bin/zsh" }), pty("pty_2")],
) {
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

  test("instances project the honest lifecycle truth: listed = alive = running (audit round-4 Major-1)", () => {
    const { handle } = fakeEngine([
      pty("pty_1", { title: "构建产物" }),
      pty("pty_2", { title: "", titleNumber: 3 }),
      pty("pty_3", { title: "  ", titleNumber: 0 }),
    ])
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!
    // 上游把 exited PTY 从 store 移除:在列即存活 → running 恒为真实存活事实,不再硬编码 false。
    expect(channel.instances()).toEqual([
      { id: "pty_1", title: "构建产物", running: true },
      { id: "pty_2", title: "终端 3", running: true },
      { id: "pty_3", title: "终端", running: true },
    ])
  })

  test("pty.exited flips the projection off: removal from the engine list kills the breathing dot", () => {
    const all = [pty("pty_1"), pty("pty_2")]
    const { handle } = fakeEngine(all)
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!
    expect(anyTerminalRunning(channel.instances())).toBe(true)

    // 上游 `pty.exited` 处理 = removeExited → store 剔除;投影随列表移除立即翻转。
    all.splice(0, 1)
    expect(channel.instances()).toHaveLength(1)
    expect(anyTerminalRunning(channel.instances())).toBe(true)
    all.splice(0, 1)
    expect(channel.instances()).toEqual([])
    expect(anyTerminalRunning(channel.instances())).toBe(false)
  })

  test("foot status shares the alive semantics, projects the shell, and passes persisted size through", () => {
    const { handle } = fakeEngine()
    const channel = mintTerminalEngineChannel({ engine: handle, identity: identityOf("ses_a"), labels })!
    // 脚条 = 运行状态 + 环境 + 尺寸(持久 cols×rows 有则出、任一维缺则整段省略)。环境段
    // 走的是真链路 `mintTerminalEngineChannel → engine.all().find() → terminalFootStatus`,
    // 不是直接调纯函数 —— 只写了纯函数却没接到投影上的实现必须在这里红(#579)。
    // 期望值 "zsh" 锚回已批稿 docs/design/current/session-workspace/design.html:374 的
    // `<span>zsh</span>`,不从生产常量 import(自指等价链会一起改错一起自洽)。
    expect(channel.footStatus("pty_1")).toEqual({ running: true, shell: "zsh", cols: 80, rows: 24 })
    // 缺数据不伪造:`toEqual` 分辨不出「键缺席」与「键存在但为 undefined」(bun 1.3.14 实测),
    // 所以「没有 shell」一律显式单独断言 —— 把 shell 伪造成 ""/"unknown" 的实现在旧写法下全绿。
    const absent = channel.footStatus("pty_2")
    expect(absent.shell).toBeUndefined()
    expect(absent).toEqual({ running: true, shell: undefined, cols: undefined, rows: undefined })
    // 实例缺席(已退出/未知 id)= false,环境段随之缺席。
    const gone = channel.footStatus("pty_gone")
    expect(gone.running).toBe(false)
    expect(gone.shell).toBeUndefined()
    expect(terminalFootStatus(undefined).shell).toBeUndefined()
    expect(terminalFootStatus(undefined).running).toBe(false)
  })

  test("terminalShellName projects a display shell name from the engine command", () => {
    // 期望值全是字面量(权威来源 = 已批稿的 `zsh`),不 import 任何生产常量。
    // 负向夹具刻意非退化:`/bin/zsh` 不得原样透传;win32 那条同时非退化于两个维度
    // (反斜杠分隔符 + `.exe` 扩展名);`zsh` 无分隔符;`/bin/` 尾随分隔符。
    expect(terminalShellName("/bin/zsh")).toBe("zsh")
    expect(terminalShellName("/usr/local/bin/fish")).toBe("fish")
    expect(terminalShellName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell")
    expect(terminalShellName("/opt/homebrew/bin/BASH")).toBe("bash")
    expect(terminalShellName("zsh")).toBe("zsh")
    expect(terminalShellName("/bin/")).toBeUndefined()
    expect(terminalShellName("")).toBeUndefined()
    expect(terminalShellName("   ")).toBeUndefined()
    expect(terminalShellName(undefined)).toBeUndefined()
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
    expect(adapterSource).toContain("persistCleanup(epoch, next)}")
    expect(adapterSource).toContain("ops.update(next)")
    expect(adapterSource).toContain("ops.trim(props.instanceID)")
    expect(adapterSource).toContain("void ops.clone(props.instanceID)")
    expect(adapterSource).toContain("autoFocus={engine.focusRequested(props.instanceID)}")
    expect(adapterSource).toContain("onAutoFocus={() => engine.consumeFocus(props.instanceID)}")
    // keep-alive × autoFocus 一次性(审计第 4 轮 Major-2):挂载中收到本实例请求 → 焦点
    // 代次 keyed 重挂,让请求经原生 autoFocus 真实被消费;DOM 级取证在 cases 文件。
    expect(adapterSource).toContain("setFocusEpoch((current) => current + 1)")
    expect(adapterSource).toContain('<Show when={focusEpoch()} keyed>')
    // keyed Show 的 children 必须带参:Solid 以 children.length>0 区分「渲染回调」与静态
    // 子元素,零参回调不会随 key 重建(本轮实测踩坑,钉死防回归)。
    expect(adapterSource).toContain("{(epoch) => (")
    // 两相位重挂(审计第 5 轮):pending 先卸旧渲 null,等本实例回写真实发生(或超时
    // 兜底)才挂新 —— 新实例必须捕获 flush 后的 store,不许同步销毁+同步挂新抢跑。
    expect(adapterSource).toContain('setRemountPhase("pending")')
    expect(adapterSource).toContain('<Show when={remountPhase() === "mounted"}>')
    expect(adapterSource).toContain("REMOUNT_FLUSH_TIMEOUT_MS")
    // 代次 token(审计第 6 轮):回写与兜底都携带自己那一代;completeRemount 只认
    // pending 正在等待的那一代,旧代次的迟到回写只落 store,推不动后来的 pending。
    expect(adapterSource).toContain("if (next.id === props.instanceID) completeRemount(epoch)")
    expect(adapterSource).toContain("if (epoch !== awaitingEpoch) return")
    expect(adapterSource).toContain("setTimeout(() => completeRemount(epoch), REMOUNT_FLUSH_TIMEOUT_MS)")
  })

  test("engine output cases run green in a real Solid mount (one-shot autoFocus + foot environment segment)", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../../test-component/terminal-engine-adapter.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 本断言就是那个 cases 文件的登记簿:取回真实数字再比,不用 `toContain("7 pass")`
    // —— 后者会被 "17 pass" 满足,粗一格就守不住自己(范式同 terminal-rail.test.ts)。
    expect(output.match(/(\d+) pass\b/)?.[1]).toBe("7")
    expect(output.match(/(\d+) fail\b/)?.[1]).toBe("0")
  })

  test("the workspace wires the real channel into the shell", () => {
    expect(workspaceSource).toContain(
      'import { useAlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-engine-adapter"',
    )
    expect(workspaceSource).toContain("const terminalChannel = useAlphaTerminalEngineChannel(current)")
    expect(workspaceSource).toContain("terminalChannel={terminalChannel}")
  })
})
