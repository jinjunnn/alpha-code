// REQ-125 #579 —— alpha 判据:客户端 PTY store 必须留住服务端下发的 `Pty.Info.command`。
//
// 为什么是 `.cases.ts` 而不是 `.test.ts`:本文件必须跑 solid 的 **dom** 构建。
// `packages/app` 的单测 lane(package.json `test:unit` / scripts/bun-test-app.sh)不带
// `--conditions=browser` ⇒ solid 的 exports map 走 `node` 条件 ⇒ `dist/server.js` ⇒
// `utils/persist.ts` 的 `createResource` 在非 hydrating 上下文下**直接抛**
// (`getNextContextId cannot be used under non-hydrating context`),报错文本与 command
// 毫无关系,看起来像「测试写错了」。宿主 `terminal-command.test.ts` 用 `Bun.spawnSync`
// 带 `--conditions=browser` 在子进程里跑本文件,并核对真实 pass/fail 数 —— 形态同
// packages/ui-mac 的 `*.cases.ts` 子进程宿主。`.cases.ts` 不被 `bun test` 自动发现,
// 故本文件的 mock 不会泄漏进整包 lane。
//
// 判据必须驱动**真的** `createWorkspaceTerminalSession`:本票的缺陷在 packages/app 的
// store 写入层,只测 alpha 侧的展示投影的话,把 `new()` 里 `command` 那行删掉照样全绿
// 而用户一个字都看不见。
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { DirectorySDK } from "./sdk"
import { ServerScope } from "@/utils/server-scope"

// ── mock 必须全部排在 `await import("./terminal")` 之前 ──────────────────────────
// bun 的 mock.module 就地改写模块命名空间对象:真模块要在覆写**之前**整体捕进独立
// const,factory 里铺开副本、只覆写要替换的那一个(少这一步 = 残缺命名空间,表现为
// 「单跑绿、整包红」或反过来)。
mock.module("@solidjs/router", () => ({
  useNavigate: () => () => undefined,
  useParams: () => ({}),
  useLocation: () => ({}),
  useSearchParams: () => [{}, () => undefined],
}))

// `./sdk` / `./server-sdk` 只被 `createWorkspaceTerminalSession` 用作类型,但它们在模块
// 顶层牵进 `@opencode-ai/sdk/v2/client` 与一串 solid-primitives —— 整片都会拉 solid,
// 失败形态是「整文件一起挂、报错与你改的东西毫无关系」。给空壳,不赌。
mock.module("./sdk", () => ({
  useSDK: () => undefined,
  SDKProvider: () => undefined,
}))
mock.module("./server-sdk", () => ({
  useServerSDK: () => () => undefined,
  ServerSDKProvider: () => undefined,
  enqueueServerEvent: () => undefined,
}))

// 真 `persisted()` 要跑(C3 就是那条读盘回合),所以 `@/utils/persist` **不 mock**。
// 它调 `usePlatform()`:钉成 web(非 desktop)⇒ 走同步 localStorage 分支(happydom 供给)。
const realPlatform = { ...(await import("@/context/platform")) }
mock.module("@/context/platform", () => ({
  ...realPlatform,
  usePlatform: () => ({ platform: "web" as const }),
}))

const { createWorkspaceTerminalSession, migrateTerminalState } = await import("./terminal")

// ── 假引擎 SDK:`client.pty.create` 返回**完整 Pty.Info 形状**(packages/schema/src/pty.ts
//    的必填字段给齐),不是只有 id/title 的退化夹具 ────────────────────────────────
type ServerPty = { id: string; title: string; command: string; args: string[]; cwd: string; status: string; pid: number }

function fakeSDK(queue: ServerPty[]) {
  const created: Array<{ title?: string }> = []
  const sdk = {
    client: {
      pty: {
        create: (input: { title?: string }) => {
          created.push(input)
          const next = queue.shift()
          return Promise.resolve(next ? { data: next } : { data: undefined })
        },
        update: () => Promise.resolve({ data: undefined }),
        remove: () => Promise.resolve({ data: undefined }),
      },
    },
    event: { on: () => () => undefined },
  }
  return { sdk: sdk as unknown as DirectorySDK, created }
}

const serverPty = (id: string, command: string): ServerPty => ({
  id,
  title: `Terminal ${id}`,
  command,
  args: ["-l"],
  cwd: "/repo/main",
  status: "running",
  pid: 4242,
})

const disposers: Array<() => void> = []

function session(sdk: DirectorySDK, dir: string) {
  return createRoot((dispose) => {
    disposers.push(dispose)
    return createWorkspaceTerminalSession(sdk, dir, ServerScope.local)
  })
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  localStorage.clear()
})

describe("REQ-125 #579 the workspace terminal store carries the server-reported command", () => {
  // C1 —— 用户 99% 走的路径(点「+」新建终端)。期望值 `/bin/zsh` 是勘破探针实跑出来的
  // 服务端真值(`Shell.preferred(undefined)`),不是从生产常量 import 来的。
  test("new() records the server-reported command", async () => {
    const { sdk, created } = fakeSDK([serverPty("pty_0001", "/bin/zsh")])
    const terminal = session(sdk, "/repo/c1")
    terminal.new()
    await settle()

    expect(created).toHaveLength(1)
    expect(terminal.all()).toHaveLength(1)
    expect(terminal.all()[0]!.command).toBe("/bin/zsh")
    // 本票不许把既有字段写成回归。
    expect(terminal.all()[0]!.id).toBe("pty_0001")
    expect(terminal.all()[0]!.title).toBe("Terminal pty_0001")
    expect(terminal.all()[0]!.titleNumber).toBe(1)
    expect(terminal.active()).toBe("pty_0001")
  })

  // C2 —— clone(连接失败时 `terminal-engine-adapter.tsx` 的 onConnectError 自动触发)换的是
  // 一条**新** PTY,服务端用默认 shell 起。产品语义 = 忠实反映服务端返回值,不沿用旧值:
  // 第二个 command 故意与第一个不同,「写死 /bin/zsh」与「clone 沿用旧 command」都会红。
  // (`setStore` 是浅合并:不显式写 command,被替换的那条会**残留旧 PTY 的 shell 名**。)
  test("clone() carries the replacement PTY's own command", async () => {
    const { sdk } = fakeSDK([serverPty("pty_0001", "/bin/zsh"), serverPty("pty_0002", "/opt/homebrew/bin/fish")])
    const terminal = session(sdk, "/repo/c2")
    terminal.new()
    await settle()
    expect(terminal.all()[0]!.command).toBe("/bin/zsh")

    await terminal.clone("pty_0001")
    await settle()

    expect(terminal.all()).toHaveLength(1)
    expect(terminal.all()[0]!.id).toBe("pty_0002")
    expect(terminal.all()[0]!.command).toBe("/opt/homebrew/bin/fish")
  })

  // C3 —— 落盘回合走生产的那条读路径(`persist.ts` readCurrent → normalize → migrate →
  // 归一化器 `pty()`),不 mock `@/utils/persist`。漏改归一化器的用户可观察表现是:
  // 新建终端当场显示 zsh、**重启后永久消失**(而且旧值被就地抹掉,persist.ts 把归一化
  // 结果写回磁盘)。
  test("the persisted round trip keeps the command across a fresh session", async () => {
    const { sdk } = fakeSDK([serverPty("pty_0001", "/bin/zsh")])
    const first = session(sdk, "/repo/c3")
    first.new()
    await settle()
    expect(first.all()[0]!.command).toBe("/bin/zsh")

    disposers.splice(0).reverse().forEach((dispose) => dispose())

    const { sdk: sdk2 } = fakeSDK([])
    const second = session(sdk2, "/repo/c3")
    await settle()

    expect(second.all()).toHaveLength(1)
    expect(second.all()[0]!.id).toBe("pty_0001")
    expect(second.all()[0]!.command).toBe("/bin/zsh")
  })

  // C4 —— 归一化器的类型闸:localStorage 里是任意 JSON,一个数字 command 会一路流到
  // alpha 侧的 `terminalShellName`。用 `"command" in obj` 而不是 `toEqual`/`toBeUndefined`:
  // 实测 bun 的 `toEqual` 分辨不出「键缺席」与「键存在但为 undefined」。
  test("the normalizer keeps a string command and drops a non-string one", () => {
    const kept = migrateTerminalState({ all: [{ id: "pty_1", title: "t", command: "/bin/zsh" }] }) as {
      all: Array<Record<string, unknown>>
    }
    expect(kept.all[0]!.command).toBe("/bin/zsh")

    const dropped = migrateTerminalState({ all: [{ id: "pty_1", title: "t", command: 42 }] }) as {
      all: Array<Record<string, unknown>>
    }
    expect("command" in dropped.all[0]!).toBe(false)
  })
})
