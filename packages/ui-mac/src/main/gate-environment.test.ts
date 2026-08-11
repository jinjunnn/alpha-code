// `#777` —— 环境咽喉的宿主。判据本体在 `test-component/gate-environment*.cases.ts`。
//
// 这道门保证什么:**一道门跑在什么环境里,由两处声明给定,而这两处合起来覆盖仓内真实存在的
// 两种运行形状**;任何一处被删掉,本文件当场红(不是「下一个人踩到时才红」)。
//
//   形状 A:单文件运行 —— 31 条 host 用例用 `Bun.spawnSync([bun, "test", <一个绝对路径>])`
//           起的子进程全是这个形状。声明在 `packages/ui-mac/scripts/test-preload.ts`
//           (`setDefaultTimeout`),因为 host 自己拼 argv,传不进 CLI flag。
//   形状 B:多文件运行 —— CI 的三条 test 步、`assert-gate-files.sh` 的 77 次点名、
//           `alpha-check.sh` 的 [4/9] 全是这个形状。声明在 `scripts/bun-test-floor.sh`
//           (`bun test --timeout`),因为**这才是所有闸门运行的唯一入口**。
//
// 为什么需要它:本包有 31 条 host 用例在子进程里跑整套 `.cases.ts`(粒度是每条 `test(...)`
// 声明,不是每个文件),其中 **19 条**从未声明过超时(实测 2026-08-03)。bun 默认 5000ms ⇒
// 谁的机器慢,谁那里就红,而红的理由与被验的行为无关。2026-08-02 起 alpha 主线
// `unit tests (alpha packages)` 连红两天,其中三条就是这个;同期还有两条是 runner 平台
// 不是本产品发布平台,生产安装闸在写盘前直接拒。
// 「间歇性 flaky」是这类红最贵的误诊 —— 它把一道真闸变成噪声。
//
// 已实测的事实(bun 1.3.14,逐条跑出来的,不是推断):
//   · `bunfig.toml` 的 `[test] timeout` **不被读取** —— 写了照样 5000ms 被杀;
//   · `BUN_TEST_TIMEOUT` / `BUN_TIMEOUT` / `BUN_TEST_TIMEOUT_MS` 全部无效;
//   · preload 里 `setDefaultTimeout()` **只对一次运行的第一个文件生效**
//     ——「单文件探针通过」会给出一个假的结论,这一点本票自己踩过一次;
//   · preload 里 `beforeAll(() => setDefaultTimeout(...))` 同样无效;
//   · `bun test --timeout N` 跨全部文件生效,且单条用例的显式超时恒胜。

import { expect, test } from "bun:test"
import path from "node:path"

const UI_MAC = path.resolve(import.meta.dir, "../..")
const REPO_ROOT = path.resolve(UI_MAC, "../..")
const SLOW = path.resolve(UI_MAC, "test-component/gate-environment.cases.ts")
const FIRST = path.resolve(UI_MAC, "test-component/gate-environment-first.cases.ts")

// `#777` 实测:形状 B 要经 `bash scripts/bun-test-floor.sh`,而那个脚本里写的是裸 `bun`。
// 在 alpha-ci 上第一版直接挂在 `bun-test-floor.sh: line 55: bun: command not found` ——
// 从 bun 进程 spawn 出去的 bash 拿到的 PATH 里没有 runner 装的那个 bun。
// 把**正在跑本测试的那个 bun**所在目录前置进 PATH:既修好,也保证父子跑的是同一个二进制。
const BUN_DIR = path.dirname(process.execPath)
const ENV = { ...process.env, PATH: `${BUN_DIR}${path.delimiter}${process.env.PATH ?? ""}` }

function run(cmd: string[], cwd: string) {
  const r = Bun.spawnSync({ cmd, cwd, env: ENV })
  return { output: `${r.stdout.toString()}${r.stderr.toString()}`, code: r.exitCode }
}

// 本宿主自己**显式**声明超时:它要等两个子进程各跑一条 6 秒用例。不声明的话,它自己就会
// 变成本文件正在讨论的那种假红(在 `bun test src` 里默认退回 5000ms)。显式值恒胜。
test(
  "环境咽喉覆盖两种运行形状(单文件子进程 + 多文件闸门入口)",
  { timeout: 180_000 },
  () => {
    // ── 形状 A:host 起子进程的那条路,单文件,靠 preload ──────────────────────
    const solo = run([process.execPath, "test", SLOW], UI_MAC)
    if (solo.code !== 0) throw new Error(`[形状 A 单文件子进程] ${solo.output}`)
    // 条数写死:少一条就是有人把两半里的一半摘了,而 `0 fail` 照样成立。
    expect(solo.output).toMatch(/Ran 2 tests across 1 file/)
    expect(solo.output).toMatch(/\b2 pass\b/)
    expect(solo.output).toMatch(/\b0 fail\b/)
    // 子进程必须**自陈**平台那一半这次到底跑没跑到 —— 开发机(darwin)跑不到,alpha-ci 跑得到。
    expect(solo.output).toMatch(/\[gate-environment\] host=/)
    // 并且要**转述到本次运行的输出里**:子进程的 stdout 被 host 吃进变量,只有失败时才抛出来 ——
    // 于是「降级了什么」这句话在绿的那一次反而看不见,而那正是需要它的时候(`#777` 实测:
    // 第一版在 alpha-ci 全绿的 run 里 grep 不到任何一行自陈)。
    for (const line of solo.output.split("\n")) {
      if (/\[gate-environment\] host=|PLATFORM SIMULATED/.test(line)) console.log(`  ↳ ${line.trim()}`)
    }

    // ── 形状 B:闸门真正的入口,多文件,靠 bun-test-floor.sh 的 --timeout ────────
    // 慢用例**必须排第二**:preload 的 setDefaultTimeout 只覆盖第一个文件,让慢的当第一个
    // 会验成一件本来就成立的事(= 形状 A),给出假绿。占位文件就是为此存在的。
    const multi = run(
      ["bash", "scripts/bun-test-floor.sh", "3", "packages/ui-mac", FIRST, SLOW],
      REPO_ROOT,
    )
    if (multi.code !== 0) throw new Error(`[形状 B 多文件闸门入口] ${multi.output}`)
    expect(multi.output).toMatch(/Ran 3 tests across 2 files/)
    expect(multi.output).toMatch(/3 条断言真的执行了/)
  },
)
