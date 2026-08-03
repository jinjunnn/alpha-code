// bun test preload —— **本包全部测试进程的环境声明处**(唯一一处)。
//
// 这个文件是 `#777` 的咽喉:一道门跑在什么环境里,由这里一次性声明,而不是由每个测试文件
// 各自记得。`packages/ui-mac/bunfig.toml` 的 `preload` 把它注入到每一个 `bun test` 进程 ——
// 包括 host 测试用 `Bun.spawnSync([process.execPath, "test", …], { cwd: packages/ui-mac })`
// 起的**子进程**(子进程 cwd 就是本包,于是读到同一份 bunfig)。新增一道门什么都不用记,
// 环境是默认给到的;想覆盖仍然可以在单条用例上显式写(显式值恒胜,已实测)。
//
// 每一条都必须是**声明 + 自陈**:静默地改环境等于把恒红换成假绿。

import { setDefaultTimeout } from "bun:test"

// ── ① UI 语言 ────────────────────────────────────────────────────────────────
// Consumed by src/renderer/i18n/index.ts detectLocale(), which prefers an explicit
// ALPHA_UI_LOCALE over navigator sniffing. `||=` respects an override the caller already
// exported (e.g. to run the suite in another locale). Child processes spawned by tests
// (alpha-composer-model.component.test.ts) inherit this via process.env.
process.env.ALPHA_UI_LOCALE ||= "zh"

// ── ② 每条用例的默认超时(**只管单文件运行**,权威在 scripts/bun-test-floor.sh)────────
// bun 默认 5000ms,对「在子进程里跑一整套 `.cases.ts`」的 host 用例来说,那不是超时,
// 是**机器速度在替断言下判决**(2026-08-02 主线连红两天,三条即此)。
//
// ⚠️ 这一行的作用范围**远小于它看起来的样子** —— 实测(bun 1.3.14):
//   `setDefaultTimeout()` 从 preload 调用,**只对一次运行的第一个测试文件生效**;
//   `bun test src`(257 个文件)从第二个文件起就退回 5000ms。
//   最初的探针只跑了单文件,于是给出一个**假的通过** —— 观测手段自己有盲区。
//   `beforeAll(() => setDefaultTimeout(...))` 同样无效。跨全部文件唯一有效的是
//   `bun test --timeout N`,而那个 flag 现在由 `scripts/bun-test-floor.sh` 一处给出。
//
// 那为什么这里还留着:**host 起的子进程都是单文件运行**(`bun test <一个绝对路径>`),
// 它们的 argv 是 host 自己拼的、传不进 flag —— 那一半正好落在本行的有效范围内。
// 两处合起来才覆盖两种形状,两处都有行为闸看着(`src/main/gate-environment.test.ts`)。
//
// 取值 120s:与仓内已显式声明超时的那批同档(最慢的正当 host 在 CI 上实测 37.7s)。
// 需要把时长本身当断言的用例(如 artifact-quota 的 `}, 1000)`)照旧显式写,显式值恒胜。
setDefaultTimeout(120_000)

// ── ③ 平台 ───────────────────────────────────────────────────────────────────
// 本产品 ship 的桌面平台是 darwin + win32(ADR-026;`ext-install-planner.ts` 的
// `synthesizeManifest` 把 `compatibility.platforms` 写死成 `["darwin","win32"]`)。
// alpha-ci 的 runner 是 ubuntu ⇒ 生产安装路径在写盘前就拒:
//   `platform linux not supported by this entry — refusing before any disk write`
// 于是那些门在 CI 上量到的是「runner 不是我们发布的平台」,不是它们存在的理由。
//
// 处置:host 平台不在发布清单里时,把 `process.platform` 钉到 darwin —— 这与 ADR-026 的
// platform seam 一致(`platform/index.ts` 每个函数的默认实参就是 `process.platform`),
// 并且 darwin 与 linux 同为 posix,`node:path` 的分支不会被改坏(win32 就会,所以只钉 darwin)。
//
// **这是一次模拟,不是覆盖**:凡是真正依赖 host 内核行为的东西,这一轮没有验到。
// 所以下面这行**必须打出来** —— 一道门可以降级,但不许静默降级。
const SHIPPED_PLATFORMS = ["darwin", "win32"] as const
if (!(SHIPPED_PLATFORMS as readonly string[]).includes(process.platform)) {
  const host = process.platform
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true, enumerable: true })
  console.log(
    `[alpha-test-env] host platform "${host}" is not one this product ships on (${SHIPPED_PLATFORMS.join("/")}). ` +
      `process.platform pinned to "darwin" so the production install gates exercise a supported platform. ` +
      `PLATFORM SIMULATED this run; genuinely ${host}-specific behaviour is NOT covered.`,
  )
}
