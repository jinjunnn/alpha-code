// `#777` —— 环境咽喉的**行为**判据(本体)。宿主在 `src/main/gate-environment.test.ts`。
//
// 这份文件被宿主用**和其余 31 条 host 用例一模一样的方式**拉起来
// (`Bun.spawnSync([process.execPath, "test", <abs>], { cwd: packages/ui-mac })`),
// 所以它验的不只是「声明写对了」,而是「声明对**子进程**也生效」——
// 那正是 2026-08-02 alpha 主线连红两天里,两条子用例被 5000ms 杀掉的位置。
//
// 刻意**不写显式超时**:显式值恒胜(已实测),写了就把要验的东西绕过去了。

import { expect, test } from "bun:test"
import os from "node:os"

import { pinShippedPlatform, SHIPPED_PLATFORMS } from "./pin-shipped-platform"

// ── ① 默认超时 ────────────────────────────────────────────────────────────────
// bun 默认 5000ms。抬高它的那两处声明(preload 管单文件、bun-test-floor.sh 管多文件)
// 只要少一处,这条 6 秒的用例就 `timed out after 5000ms`,宿主随之变红。
test("默认超时被咽喉抬过 5s —— 这条用例没有自己的超时声明", async () => {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 6_000))
  expect(Date.now() - started).toBeGreaterThanOrEqual(6_000)
})

// ── ② 平台 opt-in ─────────────────────────────────────────────────────────────
// `os.platform()` 是 host 的真实平台(钉桩只动 `process.platform`,不动它)——
// 于是这条用例在两种 host 上验的是两件不同的事,而且它**自己说出来**验的是哪一件:
//   · host 就是发布平台(开发机 darwin):`pinShippedPlatform()` 应当是 no-op —— 弱断言;
//   · host 不是发布平台(alpha-ci 的 ubuntu):它必须真的把平台钉住 —— 这才是本条存在的理由。
// 不打印这一行,本地看到「绿」会以为平台那一半验过了。测不到就说测不到。
test("pinShippedPlatform 在非发布平台上真的钉住,在发布平台上是 no-op", () => {
  const host = os.platform()
  const hostIsShipped = (SHIPPED_PLATFORMS as readonly string[]).includes(host)
  const pinned = pinShippedPlatform()
  console.log(
    hostIsShipped
      ? `[gate-environment] host=${host}(本身就是发布平台)⇒ 平台钉桩这一半**本次没有被执行**,只验了它是 no-op`
      : `[gate-environment] host=${host}(非发布平台)⇒ 平台钉桩这一半**真的被执行了**;process.platform=${process.platform}`,
  )
  expect(pinned).toBe(!hostIsShipped)
  expect(SHIPPED_PLATFORMS).toContain(process.platform)
})
