// REQ-128 Phase 4 `#809` —— wrapper 的**运行期 ABI** 闸(已批基线 §4 D1 / D3 第 2 条 / D4)。
//
// 为什么必须独占一个进程:本文件会**真的 import** 第三方那份 `plugin.js`,而它顶层就往
// `~/.opencode-notify.log` 追加一行(`plugin.js:741-748`,固定路径、从不轮换)。宿主端把
// `HOME` 换掉是唯一能在不污染开发机 / CI home 的前提下做这件事的办法,而 `os.homedir()` 在
// 进程启动之后改 `process.env.HOME` **不生效**(实测:bun 里改了也仍然返回真 home)——
// 所以只能由父进程带着改过的 `HOME` 把这个文件 spawn 起来。
//
// 三条不变量:
//   ① `mod.default` 的**自有键恰为 `{id, server}`**,`id` 是 string、`server` 是 function。
//      ⚠️ 断言对准 `mod.default`,**不是** named exports:V2 加载器读的是 `mod.default.effect` /
//      `mod.default.setup`(`packages/core/src/config/plugin/external.ts:15-30`),
//      而 `{id, server, effect}` 是**唯一**会被两个加载器同时接受的形状(双注册)。
//      一条「模块只导出 default」的断言对那个错误形状照样成立。
//   ② **顶层零副作用**:只 `import()` wrapper、不调 `server()` 的求值方(V2 就是),
//      不得让第三方字节跑起来 —— 判据是 fake home 里没有新增写盘。
//   ③ 对**固定 canary**(仓内 vendored 的那份 `opencode-notify/plugin.js`),`server()` 的返回
//      键**恰为三项**(`event` / `permission.ask` / `tool.execute.before` —— 实测,基线 §4 D3
//      写的「两项」是错的,更正理由见下面那条用例里的注释),而且**每一个值都是 function**。
//      只断「键存在」的话 `{event:1,"permission.ask":1}` 就能过,而真实引擎
//      (`packages/opencode/src/plugin/index.ts:255` / `:288-290`)**直接调用**这些值 ⇒
//      一到真实派发就抛,而形状断言全绿。
//
// **这套东西证明不了什么**(如实登记):它不证明真实引擎会把 hooks 派发到这个插件 ——
// 生产还要过 `plugin_origins` 去重、`applyPlugin` 的 detect、detect 命中后的 `resolvePluginId`。
// 那一条只由打包真机证据关闭。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, expect, test } from "bun:test"
import { managedPluginWrapperSourceV1 } from "../src/main/managed-plugin-wrapper"

const CANDIDATE = resolve(import.meta.dir, "../resources/plugins/opencode-notify/plugin.js")
/** 第三方的固定日志落点(`plugin.js:742`:`join(homedir(), ".opencode-notify.log")`)。 */
const THIRD_PARTY_LOG = join(homedir(), ".opencode-notify.log")
/** ABI 的 SOT。`Hooks` 是**类型**,运行期读不到 —— 所以对它做的是文本交叉核对,不是复制一份。 */
const ABI_SOT = resolve(import.meta.dir, "../../plugin/src/index.ts")

const tmp = mkdtempSync(join(tmpdir(), "req128-809-wrapper-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let dirSeq = 0
function materialize(upstreamSource: string | Buffer, componentId = "plugin:opencode-notify"): string {
  const dir = join(tmp, `case-${dirSeq++}`)
  mkdirSync(dir, { recursive: true })
  const wrapper = managedPluginWrapperSourceV1(componentId)
  if (!wrapper.ok) throw new Error(wrapper.reason)
  writeFileSync(join(dir, "plugin.js"), wrapper.source)
  writeFileSync(join(dir, "upstream.js"), upstreamSource)
  return dir
}

const defaultOwnKeys = (mod: { default?: unknown }): string[] =>
  Object.keys(Object.getOwnPropertyDescriptors((mod.default ?? {}) as object)).sort()

// ── 前提自检:HOME 真的被换掉了,否则下面两条「没写盘」的断言是假的 ──────────────────────────

test("前提:本进程的 home 已被父进程换成临时目录(否则本次测量作废)", () => {
  const declared = process.env.ALPHA_TEST_FAKE_HOME
  expect(typeof declared, "父进程必须声明它换成了哪个 home").toBe("string")
  expect(realpathSync(homedir())).toBe(realpathSync(declared!))
  expect(existsSync(THIRD_PARTY_LOG)).toBe(false)
})

// ── ① default 自有键恰为 {id, server} ─────────────────────────────────────────────────────────

test("wrapper 的 mod.default 自有键恰为 {id, server},且不含 effect / setup", async () => {
  const dir = materialize("export default async () => ({})\n")
  const mod = (await import(join(dir, "plugin.js"))) as { default?: Record<string, unknown> }
  expect(defaultOwnKeys(mod)).toEqual(["id", "server"])
  expect(typeof mod.default!.id).toBe("string")
  expect(typeof mod.default!.server).toBe("function")
  // V2 的 `PluginModule` schema 读的就是这两个名字;它们在场 = 双注册。
  expect("effect" in mod.default!).toBe(false)
  expect("setup" in mod.default!).toBe(false)
  // id 由组件 id 确定性派生 —— 同一个组件 id 两次生成必须逐字节相同。
  const a = managedPluginWrapperSourceV1("plugin:opencode-notify")
  const b = managedPluginWrapperSourceV1("plugin:opencode-notify")
  expect(a.ok && b.ok && a.source === b.source).toBe(true)
  expect(mod.default!.id).toBe("plugin:opencode-notify")
})

test("负向控制:同样的判据对一个 {id, server, effect} 的模块必须判否(证明它测得出已知的坏)", async () => {
  const dir = join(tmp, "negative-control")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "plugin.js"),
    "const id = \"plugin:x\"\nasync function server() { return {} }\nexport default { id, server, effect: () => {} }\n",
  )
  const mod = (await import(join(dir, "plugin.js"))) as { default?: Record<string, unknown> }
  expect(defaultOwnKeys(mod)).not.toEqual(["id", "server"])
  expect("effect" in mod.default!).toBe(true)
})

test("生成器对不合文法的组件 id 拒绝生成(它把调用方给的字符串写进会被求值的源码)", () => {
  for (const bad of ["", "Plugin:X", "no-colon", "plugin:\" + require('fs') + \"", "plugin:a\nb"]) {
    const outcome = managedPluginWrapperSourceV1(bad)
    expect(outcome.ok, bad).toBe(false)
  }
})

// ── ② 顶层零副作用 + ③ 固定 canary 的 server() 返回值 ────────────────────────────────────────

test("只 import wrapper ⇒ 第三方字节零求值;调 server() 之后才跑起来", async () => {
  const dir = materialize(readFileSync(CANDIDATE))
  const mod = (await import(join(dir, "plugin.js"))) as {
    default?: { id: string; server: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }
  }
  expect(defaultOwnKeys(mod)).toEqual(["id", "server"])
  // ② V2 加载器就是「只 import、不调 server」的那个求值方。第三方顶层会写
  // `~/.opencode-notify.log`,所以「这个文件不存在」= 第三方一行都没跑。
  expect(existsSync(THIRD_PARTY_LOG)).toBe(false)

  const hooks = await mod.default!.server({}, {})
  // 观测手段自检:调过 server() 之后日志**必须**出现 —— 否则上面那条「不存在」测的不是我以为
  // 的东西(比如 HOME 没生效、或者第三方根本不写盘),整条判据作废。
  expect(existsSync(THIRD_PARTY_LOG)).toBe(true)

  // ③ 返回键**恰为这三项**,而且**每一个值都是 function**。
  //
  // ⚠️ 已批基线 §4 D3 第 3 小条写的是「恰为两项:event 与 permission.ask」。**实读是三项** ——
  // vendored 的那份 `plugin.js` 还返回 `tool.execute.before`(`:1020`;`:762` 是 permission.ask,
  // `:803` 是 event)。基线那句大概率是从 §2.11 里「日志里有两条 HOOK 记录」推出来的,而写日志的
  // hook 与返回的 hook 不是同一个集合。此处按**实测**钉三项:照基线原文写死 2,这道闸第一天就是
  // 红的,而一条注定红的闸只会被人加豁免。
  //
  // 「值都是 function」才是本条真正拦的东西:`{event:1,"permission.ask":1}` 满足「键恰为两项」,
  // 而真实引擎在 `plugin/index.ts:255`(`void hook["event"]?.(…)`)与 `:288-290`
  // (`const fn = hook[name]; yield* Effect.promise(async () => fn(input, output))`)**直接调用**
  // 这些值 ⇒ 一到真实派发就抛,而只断形状的闸全绿。
  expect(Object.keys(hooks).sort()).toEqual(["event", "permission.ask", "tool.execute.before"])
  for (const [name, value] of Object.entries(hooks)) expect(typeof value, name).toBe("function")

  // 这三个名字必须真的是上游 `Hooks` 的顶层键 —— 对着 ABI 的 SOT 交叉核对,不在这里另抄一份
  // 21 键表(抄一份就是「手写别人文法的替身」)。
  const abi = readFileSync(ABI_SOT, "utf8")
  expect(abi).toContain("\n  event?:")
  expect(abi).toContain('\n  "permission.ask"?:')
  expect(abi).toContain('\n  "tool.execute.before"?:')
})

test("upstream.js 的 default 不是函数 ⇒ server() 响亮失败(不静默返回空 hooks)", async () => {
  const dir = materialize("export default { notAFactory: true }\n")
  const mod = (await import(join(dir, "plugin.js"))) as {
    default?: { server: (input: unknown, options: unknown) => Promise<unknown> }
  }
  await expect(mod.default!.server({}, {})).rejects.toThrow(/must default export a plugin factory/)
})
