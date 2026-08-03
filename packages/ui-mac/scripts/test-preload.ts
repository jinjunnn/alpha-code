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

// ── ③ 平台:**只检测 + 自陈,不改** ────────────────────────────────────────────
// 本产品 ship 的桌面平台是 darwin + win32(ADR-026;`ext-install-planner.ts` 的
// `synthesizeManifest` 把 `compatibility.platforms` 写死成 `["darwin","win32"]`)。
// alpha-ci 的 runner 是 ubuntu ⇒ 凡是走到生产平台闸的用例,在写盘前就被拒:
//   `platform linux not supported by this entry — refusing before any disk write`
// 它们量到的是「runner 不是我们发布的平台」,不是它们存在的理由。
//
// ⚠️ 本票**试过**在这里全局钉 `process.platform = "darwin"`,在 alpha-ci 上实测**炸得更狠**:
// 14 个 renderer 测试文件整片挂在
//   `error: Cannot find module @rollup/rollup-darwin-x64`
// —— vite/rollup 按 `process.platform` 选原生可选依赖,而 linux runner 上装的是 linux 那份。
// 3752 pass 掉到 3625。**为了修 2 条而弄坏 14 个文件,那是把一处假红换成一片真红。**
// 教训写在这里而不是只写在票里:全局改环境的代价,必须在真环境里量过才算知道。
//
// 所以平台是**按需 opt-in**:需要走生产平台闸的 cases 文件自己调
// `test-component/pin-shipped-platform.ts` 的 `pinShippedPlatform()`(它同样会自陈)。
// 这里只负责让「本次运行的 host 不是发布平台」这件事**说出口** —— 一道门可以降级,
// 但不许静默降级;而看到这行的人才知道要去 opt-in。
export const SHIPPED_PLATFORMS = ["darwin", "win32"] as const
if (!(SHIPPED_PLATFORMS as readonly string[]).includes(process.platform)) {
  console.log(
    `[alpha-test-env] host platform "${process.platform}" is not one this product ships on ` +
      `(${SHIPPED_PLATFORMS.join("/")}). PLATFORM DEGRADED this run: any gate that reaches a production ` +
      `platform check refuses before doing anything, and measures the runner instead of the behaviour. ` +
      `Such gates must opt in via pinShippedPlatform() (test-component/pin-shipped-platform.ts).`,
  )
}
