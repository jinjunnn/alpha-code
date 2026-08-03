// `#777` —— 环境咽喉的宿主。判据本体在 `test-component/gate-environment.cases.ts`。
//
// 这道门保证什么:**一道门跑在什么环境里,由 `scripts/test-preload.ts` 一处声明,
// 而且这份声明对父进程和 `Bun.spawnSync` 起的子进程同时生效。**
//
// 为什么需要它:本包有 31 条 host 用例在子进程里跑整套 `.cases.ts`(31 个文件,粒度是每条
// `test(...)` 声明,不是每个文件),其中 **19 条**从未声明过超时(实测 2026-08-03)。bun 默认 5000ms ⇒ 谁的机器慢,谁那里就红,而红的理由与被验的
// 行为毫无关系。2026-08-02 起 alpha 主线 `unit tests (alpha packages)` 连红两天,其中三条
// 就是这个;同期还有两条是 runner 平台不是本产品发布平台,生产安装闸在写盘前直接拒。
// 「间歇性 flaky」是这类红最贵的误诊 —— 它把一道真闸变成噪声。
//
// 咽喉在这里立成:新写一道门什么都不用记,环境是默认给到的;而如果有人把声明删掉,
// 本文件当场红(不是「下一个人踩到时才红」)。
//
// 已实测的三条事实(bun 1.3.14,不是推断):
//   · `bunfig.toml` 的 `[test] timeout` **不被读取** —— 写了照样 5000ms 被杀;
//   · `BUN_TEST_TIMEOUT` / `BUN_TIMEOUT` / `BUN_TEST_TIMEOUT_MS` 全部无效;
//   · `setDefaultTimeout()` 在 preload 里对父子两侧都生效,且单条用例的显式超时恒胜。

import { expect, test } from "bun:test"
import path from "node:path"

test("环境咽喉对子进程也生效(默认超时 + 平台钉桩)", () => {
  const result = Bun.spawnSync({
    // 绝对路径:`bun test <相对路径>` 会被当成**过滤器**而不是路径,匹配不到时打印
    // `N files were searched` —— 一条都没跑。31 条 host 全用 resolve,这里同构。
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../test-component/gate-environment.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 用例数写死:少一条就是有人把两半里的一半摘了,而 `0 fail` 照样成立。
  expect(output).toMatch(/Ran 2 tests across 1 file/)
  expect(output).toMatch(/\b2 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  // 子进程必须**自陈**平台那一半这次到底跑没跑到 —— 本机(darwin)跑不到,alpha-ci 跑得到。
  expect(output).toMatch(/\[gate-environment\] host=/)
})
