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

// ── ② 每条用例的默认超时 ──────────────────────────────────────────────────────
// bun 默认 5000ms。本包有 31 条 host 用例用 `Bun.spawnSync` 在子进程里跑**一整套**
// `.cases.ts`;5 秒对它们不是超时,是**机器速度在替断言下判决**。2026-08-02 起 alpha 主线
// `unit tests (alpha packages)` 连续两天全红,其中两条就是这个:
//   ext-package-detail-wiring   host  5035.75ms  ^ timed out after 5000ms
//   local-package-renderer 的两条子用例  5933.51ms / 6447.61ms  ^ timed out after 5000ms
// 同样的用例在开发机上 0 fail —— 红的理由与它要验的东西无关,而这种红最贵:它会被读成
// 「间歇性 flaky」,然后一道真闸被当噪声重试到绿(见 alpha-work/CLAUDE.md「本机验证陷阱」)。
//
// 为什么落在这里而不是逐个文件写:实测 31 条里 19 条从没写过超时(写了的 12 条是各自踩坑后
// 补的自己那一格),靠记忆的东西会漏掉 19 次。枚举对新成员默认放行,咽喉对新成员默认拒绝。
//
// 为什么不是 bunfig / 环境变量:**都实测过,都不行**(bun 1.3.14)——
//   `[test] timeout = 9000` 写进 bunfig.toml → 用例仍在 5000ms 被杀(该键不被读取);
//   BUN_TEST_TIMEOUT / BUN_TIMEOUT / BUN_TEST_TIMEOUT_MS → 全部无效;
//   `bun test --timeout` 有效,但 host 起子进程时 argv 是自己拼的,传不下去。
//   只有 `setDefaultTimeout()` 在 preload 里对**父子两侧**同时生效。
//
// 取值:本包最慢的**正当** host 在 CI 上实测 37.7s;已显式声明超时的那几个取的是 120s。
// 取 120s 与它们同档 —— 判据是「不让机器速度决定结论」,不是「越小越严」。超时不是断言:
// 一条用例卡死仍然会在 120s 内被判红,而 5s 的代价是让真闸在慢机器上恒假红。
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
