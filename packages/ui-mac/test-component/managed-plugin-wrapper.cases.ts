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
//   ③ **`server()` 把 factory 的返回值原样交出去。**(`#809` R1/M2 收紧)
//      这一条此前是「返回键恰为三项 + 每个值是 function + 对上游源码做 `toContain`」——
//      **三条一起也拦不住**一个「真调了 factory(于是日志出现、『第三方跑过了』成立)、
//      **丢掉它的返回值**、再硬编码三个空函数」的错误 wrapper:键集恰好一样,值也确实都是函数,
//      源码文本更是与本仓无关。日志只证明第三方**被执行过**,不证明**返回值被透传**。
//      现在改成两条,缺一条都不够:
//        · **期望键集直接调同一个 `upstream.js` factory 派生**,不写字面量(杀「抄成常量」);
//        · **合成 upstream 返回一个模块级 sentinel 对象,断言 wrapper 交出来的就是同一个对象**
//          (identity,不是形状 —— 这一条才杀得掉「丢弃返回值」)。顺带钉住 `(input, options)`
//          两个实参**原样**转发。
//      ⚠️ 顺带更正一条实读事实:基线 §4 D3 写的「返回键恰为两项」是错的,vendored 的那份
//      `plugin.js` 返回**三项**(`:762` permission.ask、`:803` event、`:1020` tool.execute.before)。
//      本文件不再把这个数字写死 —— 它由 factory 自己派生。
//      「这些名字是不是上游 `Hooks` 的合法键」改由**类型级约束**盯着
//      (`main/managed-plugin-wrapper.ts` 对 `@opencode-ai/plugin` 的 `import type`),
//      **不再断言上游源码文本**(那是假闸①)。
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

const tmp = mkdtempSync(join(tmpdir(), "req128-809-wrapper-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let dirSeq = 0
/** 把**生产生成器**的 wrapper 与一份 upstream 落到一个新目录里。 */
function materialize(upstreamSource: string | Buffer, componentId = "plugin:opencode-notify"): string {
  const wrapper = managedPluginWrapperSourceV1(componentId)
  if (!wrapper.ok) throw new Error(wrapper.reason)
  return materializeWith(wrapper.source, upstreamSource)
}

/** 同上,但 wrapper 的源码由调用方给 —— 负向控制用(手写一个**错误**的 wrapper)。 */
function materializeWith(wrapperSource: string, upstreamSource: string | Buffer): string {
  const dir = join(tmp, `case-${dirSeq++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plugin.js"), wrapperSource)
  writeFileSync(join(dir, "upstream.js"), upstreamSource)
  return dir
}

/**
 * 合成 upstream:默认导出的 factory 返回一个**模块级**的 hooks 对象,并把收到的两个实参记下来。
 * 「模块级」是关键 —— 它让「wrapper 交出来的是不是**同一个**对象」变成可判定的 identity 问题,
 * 而不是又一次形状比对(形状比对正是「丢弃返回值 + 硬编码同形状」能钻的空子)。
 */
const SENTINEL_UPSTREAM = `export const HOOKS = { event: async () => {}, "permission.ask": async () => {} }
export const CALLS = []
export default async (input, options) => {
  CALLS.push([input, options])
  return HOOKS
}
`

/** 一个**错误**的 wrapper:真的把 factory 调起来(日志/副作用都会发生),然后**丢掉返回值**,
 *  自己硬编码一张同形状的 hooks 表。它满足旧的三条断言 —— 本文件的负向控制就是它。 */
const DISCARDING_WRAPPER = `const id = "plugin:discarding"
async function server(input, options) {
  const upstream = await import("./upstream.js")
  await upstream.default(input, options)
  return { event: async () => {}, "permission.ask": async () => {} }
}
export default { id, server }
`

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

  // ③ 期望键集**由同一个 factory 派生**,不写字面量:直接 import 同一份 `upstream.js` 再调一次
  // 它的默认导出,拿它的键集当期望。写死一张表 = 「期望值恰好等于一个可硬编码的常量」,
  // 一个把返回值硬编码成同样三个键的 wrapper 完全满足它。
  const upstreamMod = (await import(join(dir, "upstream.js"))) as {
    default: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
  }
  const direct = await upstreamMod.default({}, {})
  expect(Object.keys(direct).length).toBeGreaterThan(0) // 前提自检:factory 真的返回了东西
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(direct).sort())
  // 值都是 function:`{event:1,…}` 满足键集断言,而真实引擎在
  // `plugin/index.ts:255`(`void hook["event"]?.(…)`)与 `:288-290`
  // (`const fn = hook[name]; yield* Effect.promise(async () => fn(input, output))`)**直接调用**
  // 这些值 ⇒ 一到真实派发就抛,而只断形状的闸全绿。
  for (const [name, value] of Object.entries(hooks)) expect(typeof value, name).toBe("function")
})

// ── ③ 的另一半:透传是 identity,不是形状 ────────────────────────────────────────────────────

test("server() 交出来的就是 factory 返回的**那个对象**,两个实参也原样转发", async () => {
  const dir = materialize(SENTINEL_UPSTREAM)
  const mod = (await import(join(dir, "plugin.js"))) as {
    default: { server: (input: unknown, options: unknown) => Promise<unknown> }
  }
  const upstreamMod = (await import(join(dir, "upstream.js"))) as {
    HOOKS: Record<string, unknown>
    CALLS: unknown[][]
  }
  const input = { marker: "req128-809-input" }
  const options = { marker: "req128-809-options" }
  const returned = await mod.default.server(input, options)
  // identity:一个「调了 factory 但丢掉返回值、自己硬编码一张同形状表」的 wrapper 在这里必红。
  expect(returned).toBe(upstreamMod.HOOKS)
  // 实参原样转发(同样是 identity —— 复制一份出来也算没转发)。
  expect(upstreamMod.CALLS).toHaveLength(1)
  expect(upstreamMod.CALLS[0]![0]).toBe(input)
  expect(upstreamMod.CALLS[0]![1]).toBe(options)
})

test("负向控制:一个「真调 factory 但丢弃返回值」的 wrapper 必须被上面那条判据判否", async () => {
  const dir = materializeWith(DISCARDING_WRAPPER, SENTINEL_UPSTREAM)
  const mod = (await import(join(dir, "plugin.js"))) as {
    default: { server: (input: unknown, options: unknown) => Promise<Record<string, unknown>> }
  }
  const upstreamMod = (await import(join(dir, "upstream.js"))) as {
    HOOKS: Record<string, unknown>
    CALLS: unknown[][]
  }
  const returned = await mod.default.server({}, {})
  // 它**确实**把 factory 调起来了(旧判据里「日志出现了」那条对它成立)……
  expect(upstreamMod.CALLS).toHaveLength(1)
  // ……键集也一模一样、值也都是函数 —— 旧的三条断言全都放它过。
  expect(Object.keys(returned).sort()).toEqual(Object.keys(upstreamMod.HOOKS).sort())
  for (const value of Object.values(returned)) expect(typeof value).toBe("function")
  // 只有 identity 判得出它:交出来的不是 factory 返回的那个对象。
  expect(returned).not.toBe(upstreamMod.HOOKS)
})

test("upstream.js 的 default 不是函数 ⇒ server() 响亮失败(不静默返回空 hooks)", async () => {
  const dir = materialize("export default { notAFactory: true }\n")
  const mod = (await import(join(dir, "plugin.js"))) as {
    default?: { server: (input: unknown, options: unknown) => Promise<unknown> }
  }
  await expect(mod.default!.server({}, {})).rejects.toThrow(/must default export a plugin factory/)
})
